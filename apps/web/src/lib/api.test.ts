import { describe, it, expect, vi, afterEach } from 'vitest';
import { authErrorMessage, confirmRun, isUnauthorized } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('confirmRun', () => {
  it('POST 到 /api/runs/:id/confirm 并回传 matched', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, matched: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await confirmRun('r1', 'c1', true);
    expect(out).toEqual({ ok: true, matched: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/runs/r1/confirm');
    expect(JSON.parse(init.body as string)).toEqual({ confirmId: 'c1', approved: true });
  });
});

describe('isUnauthorized', () => {
  it('识别 authFetch 抛出的 unauthorized', () => {
    expect(isUnauthorized(new Error('unauthorized'))).toBe(true);
  });
  it('其他错误返回 false', () => {
    expect(isUnauthorized(new Error('sessions_failed_500'))).toBe(false);
    expect(isUnauthorized('unauthorized')).toBe(false);
  });
});

describe('authErrorMessage', () => {
  it('登录 401 映射为「邮箱或密码错误」', () => {
    expect(authErrorMessage(new Error('login_failed_401'))).toBe('邮箱或密码错误');
  });
  it('注册冲突映射为「该邮箱已被注册」', () => {
    expect(authErrorMessage(new Error('register_failed_409'))).toBe('该邮箱已被注册');
  });
  it('未知错误回落到通用文案，不泄露原始 code', () => {
    const msg = authErrorMessage(new Error('some_internal_code'));
    expect(msg).toBe('操作失败，请稍后重试');
    expect(msg).not.toContain('some_internal_code');
  });
});
