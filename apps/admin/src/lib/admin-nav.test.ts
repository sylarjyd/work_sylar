import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, ADMIN_NAV_ITEMS, selectedNavKey } from './admin-nav';

describe('admin-nav', () => {
  it('导航覆盖 6 个分组与 1 个一级页面，共 12 个不重复路由', () => {
    expect(ADMIN_NAV).toHaveLength(7);
    expect(ADMIN_NAV_ITEMS).toHaveLength(12);
    const hrefs = ADMIN_NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toEqual([
      '/overview',
      '/alerts',
      '/users',
      '/tenants',
      '/plans',
      '/sessions',
      '/tasks',
      '/kb',
      '/models',
      '/settings',
      '/qa-cache',
      '/audit',
    ]);
  });

  it('缓存管理是一级菜单，不再挂在模型与配置分组下', () => {
    const cache = ADMIN_NAV.find((entry) => entry.key === 'cache');
    expect(cache).toMatchObject({ label: '缓存管理', href: '/qa-cache' });

    const models = ADMIN_NAV.find((entry) => entry.key === 'models');
    expect(models && 'items' in models ? models.items : []).not.toContainEqual(
      expect.objectContaining({ href: '/qa-cache' }),
    );
  });

  it('selectedNavKey 按前缀命中并支持子路径', () => {
    expect(selectedNavKey('/overview')).toBe('/overview');
    expect(selectedNavKey('/tasks/run-1')).toBe('/tasks');
    expect(selectedNavKey('/kb')).toBe('/kb');
    expect(selectedNavKey('/qa-cache')).toBe('/qa-cache');
    expect(selectedNavKey('/unknown')).toBe('');
    expect(selectedNavKey(null)).toBe('');
  });
});
