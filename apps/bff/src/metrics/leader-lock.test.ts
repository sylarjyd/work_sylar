import { describe, expect, it, vi } from 'vitest';
import { RedisLeaderLock, type RedisLike } from './leader-lock';

describe('RedisLeaderLock', () => {
  it('用 SET key value PX ttl NX 抢锁', async () => {
    const set = vi.fn(async () => 'OK' as const);
    const lock = new RedisLeaderLock({ set, disconnect: () => undefined } as RedisLike);
    await expect(lock.acquire('k', 55_000)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('k', expect.any(String), 'PX', 55_000, 'NX');
  });

  it('未抢到锁返回 false', async () => {
    const lock = new RedisLeaderLock({
      set: async () => null,
      disconnect: () => undefined,
    });
    await expect(lock.acquire('k', 55_000)).resolves.toBe(false);
  });

  it('未配置或 Redis 异常时 fail-open 执行', async () => {
    const warn = vi.fn();
    const noRedis = new RedisLeaderLock(null, { warn });
    await expect(noRedis.acquire('k', 55_000)).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();

    const broken = new RedisLeaderLock(
      {
        set: async () => {
          throw new Error('redis down');
        },
        disconnect: () => undefined,
      },
      { warn },
    );
    await expect(broken.acquire('k', 55_000)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
