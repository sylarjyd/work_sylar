import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import type { PrismaService } from '../db/prisma.service';

function ctxFor(sub: string | undefined): ExecutionContext {
  const req: { user?: { sub: string; tenantId: string } } = sub ? { user: { sub, tenantId: 't1' } } : {};
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function guardWith(role: string | null) {
  const prisma = {
    user: { findUnique: async () => (role === null ? null : { role }) },
  } as unknown as PrismaService;
  return new AdminGuard(prisma);
}

describe('AdminGuard', () => {
  it('角色为 admin 放行', async () => {
    await expect(guardWith('admin').canActivate(ctxFor('u1'))).resolves.toBe(true);
  });

  it('角色非 admin 抛 Forbidden not_admin', async () => {
    await expect(guardWith('member').canActivate(ctxFor('u1'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('用户不存在抛 Forbidden', async () => {
    await expect(guardWith(null).canActivate(ctxFor('u1'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('无 req.user（未过 JwtGuard）抛 Forbidden', async () => {
    await expect(guardWith('admin').canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
