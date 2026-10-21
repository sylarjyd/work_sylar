import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getEmail, getRole, getToken, login, register } from './auth';

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
