import { describe, it, expect } from 'vitest';
import { adminRedirectPath } from './admin-guard';

describe('adminRedirectPath', () => {
  it('管理员不跳转', () => {
    expect(adminRedirectPath('admin')).toBeNull();
  });
  it('成员与空角色跳回工作台', () => {
    expect(adminRedirectPath('member')).toBe('/');
    expect(adminRedirectPath(null)).toBe('/');
  });
});
