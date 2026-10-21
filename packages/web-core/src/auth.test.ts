import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, fetchMe, getEmail, getRole, getToken, login, register } from './auth';

function createStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('登录态存储', () => {
  it('clearToken 同时清除 token / role / email', () => {
    window.localStorage.setItem('ai_office_token', 't');
    window.localStorage.setItem('ai_office_role', 'admin');
    window.localStorage.setItem('ai_office_email', 'demo@example.com');

    clearToken();

    expect(getToken()).toBeNull();
    expect(getRole()).toBeNull();
    expect(getEmail()).toBeNull();
  });

  it('fetchMe 用 token 拉取身份并回填 role / email', async () => {
    window.localStorage.setItem('ai_office_token', 't');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'u1', email: 'demo@example.com', role: 'admin' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = await fetchMe();

    expect(user).toEqual({ id: 'u1', email: 'demo@example.com', role: 'admin' });
    expect(getEmail()).toBe('demo@example.com');
    expect(getRole()).toBe('admin');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/me'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer t' }),
      }),
    );
  });

  it('fetchMe 返回 401 时清空登录态并抛出 unauthorized', async () => {
    window.localStorage.setItem('ai_office_token', 't');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));

    await expect(fetchMe()).rejects.toThrow('unauthorized');
    expect(getToken()).toBeNull();
  });

  it('fetchMe 返回时若 token 已更换则不写回，避免覆盖新登录态', async () => {
    window.localStorage.setItem('ai_office_token', 'old');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // 模拟请求在途时用户退出并登录了另一个账号。
        window.localStorage.setItem('ai_office_token', 'new');
        return new Response(JSON.stringify({ id: 'u1', email: 'old@example.com', role: 'admin' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await fetchMe();

    expect(getToken()).toBe('new');
    expect(getEmail()).toBeNull();
    expect(getRole()).toBeNull();
  });

  it.each([
    ['login', login, '/api/auth/login'],
    ['register', register, '/api/auth/register'],
  ])('%s 成功后持久化 token / role / email', async (_name, action, path) => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify({
          token: 't',
          user: { id: 'u1', email: 'demo@example.com', role: 'admin' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await action('demo@example.com', 'demo-password');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(path),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getToken()).toBe('t');
    expect(getRole()).toBe('admin');
    expect(getEmail()).toBe('demo@example.com');
  });
});
