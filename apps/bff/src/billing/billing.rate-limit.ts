import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

/** 原子完成 INCR 与首次 EXPIRE，避免计数成功而过期失败留下无 TTL 的键。 */
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds?: number): Promise<RateLimitResult>;
  /** 释放底层连接；内存实现无需实现。 */
  close?(): Promise<void>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/** 单实例固定窗口；多实例部署必须配 Redis。 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
    const now = Date.now();
    const window = Math.floor(now / (windowSeconds * 1000));
    const bucketKey = `${key}:${window}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: (window + 1) * windowSeconds * 1000 };
      this.buckets.set(bucketKey, bucket);
      if (this.buckets.size > 10_000) this.prune(now);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/** Redis 固定窗口：Lua 原子计数 + 首次过期；故障时放行（账本与预占仍是硬约束）。 */
export class RedisRateLimiter implements RateLimiter {
  private readonly logger = new Logger(RedisRateLimiter.name);
  private lastWarnAt = 0;

  constructor(private readonly redis: Redis) {
    // ioredis 的 error 事件无监听时仅内部打印；这里接管以便统一节流告警。
    this.redis.on('error', (err: Error) => {
      this.warnThrottled(`Redis 限流器连接错误：${err.message}`);
    });
  }

  async hit(key: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey = `rl:${key}:${window}`;
    try {
      const count = Number(await this.redis.eval(INCR_SCRIPT, 1, redisKey, windowSeconds * 2));
      const resetAt = (window + 1) * windowSeconds * 1000;
      return {
        allowed: count <= limit,
        // 与内存实现保持一致：返回当前窗口的剩余秒数。
        retryAfter: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      };
    } catch (err) {
      this.warnThrottled(`Redis 限流器不可用，已放行请求：${(err as Error).message}`);
      return { allowed: true, retryAfter: 0 };
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }

  /** Redis 长时间不可用时每 10 秒最多告警一次，避免刷屏。 */
  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt <= 10_000) return;
    this.lastWarnAt = now;
    this.logger.warn(message);
  }
}

export function createRateLimiter(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const url = env.REDIS_URL;
  if (!url) return new MemoryRateLimiter();
  return new RedisRateLimiter(
    new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 }),
  );
}
