import { describe, it, expect } from 'vitest';
import { MemoryRateLimiter } from './billing.rate-limit';

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
