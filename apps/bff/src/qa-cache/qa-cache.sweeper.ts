import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RUN_REDIS } from '../queue/redis.provider';
import { QA_CACHE_INDEX_KEY, withCacheTimeout } from './qa-cache.service';

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;

/** 定期清理问答缓存索引中的过期成员；条目本身由 Redis TTL 回收。 */
@Injectable()
export class QaCacheSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QaCacheSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Optional() @Inject(RUN_REDIS) private readonly redis: Redis | null) {}

  onModuleInit(): void {
    if (!this.redis) return;
    const text = process.env.QA_CACHE_SWEEP_MS;
    const raw = text === undefined || text.trim() === '' ? DEFAULT_INTERVAL_MS : Number(text);
    // 0 是显式关闭开关，不能退化成默认 60 秒。
    if (raw === 0) {
      this.logger.warn('[qa-cache] QA_CACHE_SWEEP_MS=0，过期索引清理已关闭');
      return;
    }
    const interval =
      Number.isFinite(raw) && raw > 0 ? Math.max(MIN_INTERVAL_MS, raw) : DEFAULT_INTERVAL_MS;
    if (raw !== interval) {
      this.logger.warn(`[qa-cache] QA_CACHE_SWEEP_MS 超出允许范围，已调整为 ${interval}ms`);
    }
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出（测试/短生命周期命令）。
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(now = Date.now()): Promise<void> {
    const redis = this.redis;
    if (!redis || this.running) return;
    this.running = true;
    try {
      await withCacheTimeout(redis.zremrangebyscore(QA_CACHE_INDEX_KEY, '-inf', String(now)));
    } catch (err) {
      this.logger.warn(`[qa-cache] 清理过期索引失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
