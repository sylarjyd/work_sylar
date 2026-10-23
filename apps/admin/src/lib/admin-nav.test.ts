import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, ADMIN_NAV_ITEMS, selectedNavKey } from './admin-nav';

describe('admin-nav', () => {
  it('分组覆盖 6 组 11 个不重复路由', () => {
    expect(ADMIN_NAV).toHaveLength(6);
    expect(ADMIN_NAV_ITEMS).toHaveLength(11);
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
      '/audit',
    ]);
  });

  it('selectedNavKey 按前缀命中并支持子路径', () => {
    expect(selectedNavKey('/overview')).toBe('/overview');
    expect(selectedNavKey('/tasks/run-1')).toBe('/tasks');
    expect(selectedNavKey('/kb')).toBe('/kb');
    expect(selectedNavKey('/unknown')).toBe('');
    expect(selectedNavKey(null)).toBe('');
  });
});
