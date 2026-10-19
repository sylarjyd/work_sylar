import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { MemoryRateLimiter, RedisRateLimiter } from './billing.rate-limit';

beforeEach(() => {
  // 固定时钟，避免用例恰好跨窗口边界时偶发失败。
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryRateLimiter', () => {
  it('窗口内超限拒绝，并给出重试秒数', async () => {
    const limiter = new MemoryRateLimiter();
    expect((await limiter.hit('t1', 2)).allowed).toBe(true);
    expect((await limiter.hit('t1', 2)).allowed).toBe(true);
    const third = await limiter.hit('t1', 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it('不同租户互不影响', async () => {
    const limiter = new MemoryRateLimiter();
    await limiter.hit('a', 1);
    expect((await limiter.hit('b', 1)).allowed).toBe(true);
  });
});

describe('RedisRateLimiter', () => {
  function stubRedis(evalImpl: () => Promise<number>) {
    const redis = {
      eval: vi.fn(evalImpl),
      on: vi.fn(),
      disconnect: vi.fn(),
    };
    return { redis, limiter: new RedisRateLimiter(redis as unknown as Redis) };
  }

  it('计数超过限额时拒绝，并给出剩余重试秒数', async () => {
    const { limiter } = stubRedis(async () => 3);
    const result = await limiter.hit('t1', 2);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('Redis 故障时放行（fail-open）', async () => {
    const { limiter } = stubRedis(async () => {
      throw new Error('redis down');
    });
    await expect(limiter.hit('t1', 2)).resolves.toEqual({ allowed: true, retryAfter: 0 });
  });

  it('close 断开底层连接', async () => {
    const { redis, limiter } = stubRedis(async () => 1);
    await limiter.close();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
