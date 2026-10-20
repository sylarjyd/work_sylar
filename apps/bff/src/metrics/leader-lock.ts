import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

export const LEADER_LOCK = Symbol('LEADER_LOCK');
/** Redis 会话锁 TTL：任务正常远短于 55 秒；超时重入由 upsert/openKey 兜底。 */
export const LEADER_TTL_MS = 55_000;

export interface LeaderLock {
  acquire(key: string, ttlMs?: number): Promise<boolean>;
  /** 显式释放连接，避免 useFactory 提供者未触发 Nest 生命周期钩子时进程挂住。 */
  close?(): void;
}

export interface RedisLike {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttl: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  disconnect(): void;
}

export type WarnLogger = Pick<Logger, 'warn'>;

/**
 * Redis SET NX PX 选主。Redis 未配置或暂时不可用时 fail-open：
 * 快照 upsert 天然幂等，告警侧再由 openKey 唯一约束兜底，不能让选主故障阻断采集。
 */
export class RedisLeaderLock implements LeaderLock {
  private readonly logger: WarnLogger;
  private readonly token = randomUUID();

  constructor(
    private readonly redis: RedisLike | null,
    logger: WarnLogger = new Logger(RedisLeaderLock.name),
  ) {
    this.logger = logger;
  }

  async acquire(key: string, ttlMs = LEADER_TTL_MS): Promise<boolean> {
    if (!this.redis) {
      this.logger.warn(`[metrics] REDIS_URL 未配置，${key} 将在每个实例执行`);
      return true;
    }
    try {
      const result = await this.redis.set(key, this.token, 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`[metrics] Redis 选主失败，本轮继续执行: ${(err as Error).message}`);
      return true;
    }
  }

  close(): void {
    this.redis?.disconnect?.();
  }

  /** 由 Nest 在模块销毁时调用；与 close 幂等。 */
  onModuleDestroy(): void {
    this.close();
  }
}

export function createLeaderLock(env: NodeJS.ProcessEnv = process.env): RedisLeaderLock {
  const url = env.REDIS_URL;
  if (!url) return new RedisLeaderLock(null);
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    // 命令级超时：Redis 卡死时选主不能无限挂起，fail-open 才能生效。
    commandTimeout: 2000,
  });
  // ioredis 的 set 重载比 RedisLike 更宽，运行时完全兼容。
  return new RedisLeaderLock(redis as unknown as RedisLike);
}
