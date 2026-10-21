import { describe, it, expect } from 'vitest';
import { adminRedirectPath } from './admin-guard';

describe('adminRedirectPath', () => {
  it('管理员不跳转', () => {
    expect(adminRedirectPath('admin')).toBeNull();
  });
  it('成员与空角色跳回运营端登录页', () => {
    expect(adminRedirectPath('member')).toBe('/login');
    expect(adminRedirectPath(null)).toBe('/login');
  });
});
