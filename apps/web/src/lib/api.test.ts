import { describe, it, expect } from 'vitest';
import { authErrorMessage, isUnauthorized } from './api';

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
