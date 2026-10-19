import { describe, it, expect, vi, afterEach } from 'vitest';
import { adminErrorText, isForbidden, listAdminUsers } from './admin-api';

afterEach(() => vi.unstubAllGlobals());

function stubWindow() {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => (k === 'ai_office_token' ? 'tok' : null),
      setItem: () => {},
      removeItem: () => {},
    },
  });
}

describe('admin-api', () => {
  it('分页参数拼进 query，空值忽略', async () => {
    stubWindow();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [], total: 0, page: 2, pageSize: 50 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await listAdminUsers({ page: 2, pageSize: 50, q: '' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('/api/admin/users?page=2&pageSize=50');
    expect(String(url)).not.toContain('q=');
  });

  it('403 映射为 forbidden', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    const err = await listAdminUsers({ page: 1 }).catch((e) => e);
    expect(isForbidden(err)).toBe(true);
  });

  it('错误码可读文案', () => {
    expect(adminErrorText(new Error('forbidden'))).toBe('当前账号没有管理权限');
    expect(adminErrorText(new Error('admin_failed_400_last_admin'))).toBe(
      '系统必须保留至少一个启用的管理员',
    );
  });
});
