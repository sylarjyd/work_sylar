import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RUN_REDIS } from '../queue/redis.provider';

export const QA_CACHE_INDEX_KEY = 'qa:cache:index';
/** Redis 抖动时不能拖住运行链路：每条缓存命令都要有明确上限。 */
const CACHE_COMMAND_TIMEOUT_MS = 300;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface QaCacheEntry {
  tenantId: string;
  userId: string;
  sessionId: string;
  question: string;
  answer: string;
  createdAt: number;
  expiresAt: number;
}

export interface QaCacheStoredEntry extends QaCacheEntry {
  hash: string;
}

/** 去首尾空白、连续空白折叠为单个空格、英文转小写；不做同义词或语义匹配。 */
export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 键绑定用户、会话与规范化问题：任一不同都不能命中。 */
export function qaCacheHash(userId: string, sessionId: string, question: string): string {
  return createHash('sha256')
    .update(`${userId}\n${sessionId}\n${normalizeQuestion(question)}`)
    .digest('hex');
}

export function isQaCacheHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

function entryKey(hash: string): string {
  return `qa:cache:entry:${hash}`;
}

/** 超时后底层命令可能仍在跑，由 ioredis 自行收敛；这里只保证调用方不被挂住。 */
export function withCacheTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('cache_timeout')), CACHE_COMMAND_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseEntry(raw: string): QaCacheEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const entry = data as Record<string, unknown>;
  if (
    typeof entry.tenantId !== 'string' ||
    typeof entry.userId !== 'string' ||
    typeof entry.sessionId !== 'string' ||
    typeof entry.question !== 'string' ||
    typeof entry.answer !== 'string' ||
    typeof entry.createdAt !== 'number' ||
    typeof entry.expiresAt !== 'number'
  ) {
    return null;
  }
  return {
    tenantId: entry.tenantId,
    userId: entry.userId,
    sessionId: entry.sessionId,
    question: entry.question,
    answer: entry.answer,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

/**
 * 会话内问答缓存：条目由 Redis TTL 负责过期，ZSET 索引供运营端按过期时间分页。
 * 读写异常由调用方决定如何降级——运行链路跳过，管理端返回 503。
 */
@Injectable()
export class QaCacheService {
  private readonly logger = new Logger(QaCacheService.name);

  constructor(@Optional() @Inject(RUN_REDIS) private readonly redis: Redis | null) {}

  get available(): boolean {
    return this.redis !== null;
  }

  /** 命中返回条目；未命中、已过期、属主不符或数据损坏都返回 null。 */
  async lookup(params: {
    userId: string;
    sessionId: string;
    question: string;
  }): Promise<QaCacheEntry | null> {
    const redis = this.redis;
    if (!redis || normalizeQuestion(params.question) === '') return null;
    const hash = qaCacheHash(params.userId, params.sessionId, params.question);
    const raw = await withCacheTimeout(redis.get(entryKey(hash)));
    if (raw === null) return null;
    const entry = parseEntry(raw);
    if (!entry || entry.userId !== params.userId || entry.sessionId !== params.sessionId) {
      this.logger.warn(`问答缓存条目无效，已删除: ${hash}`);
      await this.drop(hash);
      return null;
    }
    return entry;
  }

  /** 成功运行后写入/续期：同一 hash 覆盖旧答案，TTL 从当前时刻重算。 */
  async remember(params: {
    tenantId: string;
    userId: string;
    sessionId: string;
    question: string;
    answer: string;
    ttlSeconds: number;
  }): Promise<void> {
    const redis = this.redis;
    const question = params.question.trim();
    const answer = params.answer.trim();
    if (
      !redis ||
      question === '' ||
      answer === '' ||
      !Number.isSafeInteger(params.ttlSeconds) ||
      params.ttlSeconds <= 0
    ) {
      return;
    }
    const now = Date.now();
    const entry: QaCacheEntry = {
      tenantId: params.tenantId,
      userId: params.userId,
      sessionId: params.sessionId,
      question,
      answer,
      createdAt: now,
      expiresAt: now + params.ttlSeconds * 1000,
    };
    const hash = qaCacheHash(params.userId, params.sessionId, question);
    await withCacheTimeout(
      redis
        .multi()
        .set(entryKey(hash), JSON.stringify(entry), 'EX', params.ttlSeconds)
        .zadd(QA_CACHE_INDEX_KEY, entry.expiresAt, hash)
        .exec(),
    );
  }

  /** 管理端按 hash 读取；未命中返回 null。 */
  async get(hash: string): Promise<QaCacheEntry | null> {
    const redis = this.redis;
    if (!redis) throw new ServiceUnavailableException('cache_unavailable');
    const raw = await withCacheTimeout(redis.get(entryKey(hash)));
    return raw === null ? null : parseEntry(raw);
  }

  /** 删除条目与索引；条目不存在也视为成功。 */
  async remove(hash: string): Promise<void> {
    const redis = this.redis;
    if (!redis) throw new ServiceUnavailableException('cache_unavailable');
    await withCacheTimeout(
      redis.multi().del(entryKey(hash)).zrem(QA_CACHE_INDEX_KEY, hash).exec(),
    );
  }

  /** 运营端未过期条目分页：索引按过期时间升序，条目已过期但索引残留时顺手清理。 */
  async list(params: {
    offset: number;
    limit: number;
  }): Promise<{ items: QaCacheStoredEntry[]; total: number }> {
    const redis = this.redis;
    if (!redis) throw new ServiceUnavailableException('cache_unavailable');
    const min = String(Date.now() + 1);
    const [total, hashes] = await Promise.all([
      withCacheTimeout(redis.zcount(QA_CACHE_INDEX_KEY, min, '+inf')),
      withCacheTimeout(
        redis.zrangebyscore(QA_CACHE_INDEX_KEY, min, '+inf', 'LIMIT', params.offset, params.limit),
      ),
    ]);
    if (hashes.length === 0) return { items: [], total };

    const raws = await withCacheTimeout(redis.mget(...hashes.map((hash) => entryKey(hash))));
    const items: QaCacheStoredEntry[] = [];
    const stale: string[] = [];
    hashes.forEach((hash, index) => {
      const raw = raws[index];
      const entry = raw === null || raw === undefined ? null : parseEntry(raw);
      if (!entry) {
        stale.push(hash);
        return;
      }
      items.push({ hash, ...entry });
    });
    if (stale.length > 0) {
      this.logger.warn(`清理问答缓存残留索引 ${stale.length} 条`);
      await this.drop(stale);
    }
    return { items, total };
  }

  private async drop(hashes: string | string[]): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    const list = Array.isArray(hashes) ? hashes : [hashes];
    try {
      const pipeline = redis.multi();
      for (const hash of list) pipeline.del(entryKey(hash));
      pipeline.zrem(QA_CACHE_INDEX_KEY, ...list);
      await withCacheTimeout(pipeline.exec());
    } catch (err) {
      this.logger.warn(`清理问答缓存失败: ${(err as Error).message}`);
    }
  }
}
