import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function ctxWithUser(user?: { sub: string; tenantId: string; role?: string }): ExecutionContext {
  const req: { user?: { sub: string; tenantId: string; role?: string } } = user ? { user } : {};
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  it('req.user.role 为 admin 时放行', () => {
    expect(new AdminGuard().canActivate(ctxWithUser({ sub: 'u1', tenantId: 't1', role: 'admin' }))).toBe(true);
  });

  it('非管理员抛 Forbidden not_admin', () => {
    const err = (() => {
      try {
        new AdminGuard().canActivate(ctxWithUser({ sub: 'u2', tenantId: 't1', role: 'member' }));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe('not_admin');
  });

  it('未经过 JwtGuard（无 req.user）抛 Forbidden', () => {
    expect(() => new AdminGuard().canActivate(ctxWithUser())).toThrow(ForbiddenException);
  });
});
