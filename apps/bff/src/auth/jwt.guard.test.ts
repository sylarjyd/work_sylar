import { describe, it, expect, beforeAll } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { signToken } from './jwt';
import type { PrismaService } from '../db/prisma.service';

function ctxWithAuthHeader(header?: string): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; user?: unknown };
} {
  const req: { headers: Record<string, string>; user?: unknown } = { headers: {} };
  if (header !== undefined) req.headers.authorization = header;
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

function guardWith(
  user: { status: string; role: string; tenantId: string; email: string } | null,
): JwtGuard {
  const prisma = { user: { findUnique: async () => user } } as unknown as PrismaService;
  return new JwtGuard(prisma);
}

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

describe('JwtGuard', () => {
  it('缺少 Authorization 头时抛 missing_token', async () => {
    const { ctx } = ctxWithAuthHeader();
    await expect(guardWith(null).canActivate(ctx)).rejects.toMatchObject({ message: 'missing_token' });
  });

  it('被篡改的 token 抛 invalid_token', async () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}x`);
    await expect(guardWith(null).canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('启用用户放行，并用库中角色/邮箱回填 req.user', async () => {
    const { ctx, req } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    const guard = guardWith({ status: 'active', role: 'admin', tenantId: 't1', email: 'a@b.c' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'u1', tenantId: 't1', role: 'admin', email: 'a@b.c' });
  });

  it('禁用用户 401', async () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    const guard = guardWith({ status: 'disabled', role: 'member', tenantId: 't1', email: 'a@b.c' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ message: 'invalid_token' });
  });

  it('用户不存在 401', async () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    await expect(guardWith(null).canActivate(ctx)).rejects.toMatchObject({ message: 'invalid_token' });
  });
});
