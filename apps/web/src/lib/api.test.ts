import { describe, it, expect, vi, afterEach } from 'vitest';
import { authErrorMessage, confirmRun, isUnauthorized, listConnectors, createConnector } from './api';

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

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
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

describe('uploadKbDoc', () => {
  it('uploadKbDoc 用 FormData 且不覆盖 content-type', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'd1',
            filename: 'a.txt',
            mime: 'text/plain',
            size: 1,
            status: 'pending',
            chunkCount: 0,
            error: null,
            createdAt: '2026-01-01T00:00:00Z',
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Node 环境没有 window/localStorage，stub window 让 getToken() 返回 'tok'。
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'tok', setItem: () => {}, removeItem: () => {} },
    });

    const { uploadKbDoc } = await import('./api');
    await uploadKbDoc(new File(['x'], 'a.txt', { type: 'text/plain' }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/kb/docs');
    expect(init.body).toBeInstanceOf(FormData);
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(headers.authorization).toBe('Bearer tok');
  });
});

describe('connectors api', () => {
  it('listConnectors GET /api/connectors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: 'c1', name: 'echo' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await listConnectors();
    expect(out).toHaveLength(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain('/api/connectors');
  });

  it('createConnector POST 携带 JSON 体', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'c1', name: 'echo' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await createConnector({ name: 'echo', command: 'node', args: ['s.mjs'], env: { K: 'v' } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'echo', command: 'node', args: ['s.mjs'], env: { K: 'v' } });
  });
});
