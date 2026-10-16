import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfirmBroker } from './broker';

afterEach(() => {
  vi.useRealTimers();
});

describe('ConfirmBroker', () => {
  it('resolve 放行兑现', async () => {
    const b = new ConfirmBroker();
    const p = b.request('r1', 'c1', 10_000);
    expect(b.resolve('r1', 'c1', true)).toBe(true);
    await expect(p).resolves.toEqual({ approved: true });
  });

  it('resolve 拒绝时带 user_denied', async () => {
    const b = new ConfirmBroker();
    const p = b.request('r1', 'c1', 10_000);
    b.resolve('r1', 'c1', false);
    await expect(p).resolves.toEqual({ approved: false, reason: 'user_denied' });
  });

  it('confirmId 不匹配返回 false 且不兑现', async () => {
    const b = new ConfirmBroker();
    const p = b.request('r1', 'c1', 10_000);
    expect(b.resolve('r1', 'wrong', true)).toBe(false);
    // 挂起仍在：用正确 id 仍可兑现。
    expect(b.resolve('r1', 'c1', true)).toBe(true);
    await expect(p).resolves.toEqual({ approved: true });
  });

  it('未知 runId 返回 false', () => {
    const b = new ConfirmBroker();
    expect(b.resolve('nope', 'c1', true)).toBe(false);
  });

  it('重复 resolve 第二次返回 false（幂等）', async () => {
    const b = new ConfirmBroker();
    const p = b.request('r1', 'c1', 10_000);
    expect(b.resolve('r1', 'c1', true)).toBe(true);
    expect(b.resolve('r1', 'c1', true)).toBe(false);
    await p;
  });

  it('超时按 confirm_timeout 兑现', async () => {
    vi.useFakeTimers();
    const b = new ConfirmBroker();
    const p = b.request('r1', 'c1', 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toEqual({ approved: false, reason: 'confirm_timeout' });
  });

  it('cancel 按拒绝兑现并清理', async () => {
    const b = new ConfirmBroker();
    const p = b.request('r1', 'c1', 10_000);
    b.cancel('r1');
    await expect(p).resolves.toEqual({ approved: false, reason: 'user_denied' });
    // 已清理：随后的 resolve 不再命中。
    expect(b.resolve('r1', 'c1', true)).toBe(false);
  });

  it('同一 runId 已有挂起时，新请求直接被拒', async () => {
    const b = new ConfirmBroker();
    const first = b.request('r1', 'c1', 10_000);
    const second = b.request('r1', 'c2', 10_000);
    await expect(second).resolves.toEqual({ approved: false });
    b.resolve('r1', 'c1', true);
    await expect(first).resolves.toEqual({ approved: true });
  });
});
