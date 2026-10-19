import { Redis } from 'ioredis';

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

/** Redis 固定窗口：INCR + 首次过期；故障时放行（账本与预占仍是硬约束）。 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey = `rl:${key}:${window}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) await this.redis.expire(redisKey, windowSeconds * 2);
      return { allowed: count <= limit, retryAfter: windowSeconds };
    } catch {
      return { allowed: true, retryAfter: 0 };
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

export function createRateLimiter(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const url = env.REDIS_URL;
  if (!url) return new MemoryRateLimiter();
  return new RedisRateLimiter(new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 }));
}
