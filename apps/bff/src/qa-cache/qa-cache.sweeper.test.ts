import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { QaCacheSweeper } from './qa-cache.sweeper';

function makeRedis(index: Map<string, number>): Redis {
  return {
    zremrangebyscore: async (_key: string, _min: string, max: string) => {
      let removed = 0;
      for (const [member, score] of [...index.entries()]) {
        if (score <= Number(max)) {
          index.delete(member);
          removed += 1;
        }
      }
      return removed;
    },
  } as unknown as Redis;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.QA_CACHE_SWEEP_MS;
});

describe('QaCacheSweeper', () => {
  it('每轮按当前时间清理已过期的索引成员', async () => {
    const index = new Map<string, number>();
    const now = Date.now();
    index.set('expired', now - 1_000);
    index.set('alive', now + 60_000);
    const sweeper = new QaCacheSweeper(makeRedis(index));

    await sweeper.tick(now);

    expect(index.has('expired')).toBe(false);
    expect(index.has('alive')).toBe(true);
  });

  it('未配置 Redis 时不做任何事', async () => {
    const sweeper = new QaCacheSweeper(null);
    await expect(sweeper.tick()).resolves.toBeUndefined();
  });

  it('QA_CACHE_SWEEP_MS=0 时关闭定时器', () => {
    process.env.QA_CACHE_SWEEP_MS = '0';
    const interval = vi.spyOn(globalThis, 'setInterval');
    const sweeper = new QaCacheSweeper(makeRedis(new Map()));

    sweeper.onModuleInit();

    expect(interval).not.toHaveBeenCalled();
    sweeper.onModuleDestroy();
  });
});
