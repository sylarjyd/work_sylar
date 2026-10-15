import { describe, it, expect, beforeAll } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { signToken } from './jwt';

/** 造一个最小可用的 ExecutionContext，只暴露 guard 真正用到的 switchToHttp().getRequest()。 */
function ctxWithAuthHeader(header?: string): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; user?: unknown };
} {
  const req: { headers: Record<string, string>; user?: unknown } = { headers: {} };
  if (header !== undefined) req.headers.authorization = header;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

/** 跑一次 canActivate，返回捕获到的异常（未抛出则返回 undefined）。 */
function catchActivate(ctx: ExecutionContext): unknown {
  const guard = new JwtGuard();
  try {
    guard.canActivate(ctx);
    return undefined;
  } catch (e) {
    return e;
  }
}

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

describe('JwtGuard', () => {
  it('缺少 Authorization 头时抛 missing_token', () => {
    const { ctx } = ctxWithAuthHeader();
    const err = catchActivate(ctx);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('missing_token');
  });

  it('非 Bearer scheme 抛 missing_token', () => {
    const { ctx } = ctxWithAuthHeader('Token abc');
    const err = catchActivate(ctx);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('missing_token');
  });

  it('Bearer 后没有 token 抛 missing_token', () => {
    const { ctx } = ctxWithAuthHeader('Bearer');
    const err = catchActivate(ctx);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('missing_token');
  });

  it('被篡改的 token 抛 invalid_token', () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}x`);
    const err = catchActivate(ctx);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('invalid_token');
  });

  it('合法 token 返回 true 并把 payload 挂到 req.user', () => {
    const guard = new JwtGuard();
    const { ctx, req } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    expect(guard.canActivate(ctx)).toBe(true);
    // verifyToken 返回的是完整解码 payload，除自定义字段外还带 iat/exp，故用 toMatchObject。
    expect(req.user).toMatchObject({ sub: 'u1', tenantId: 't1' });
  });
});
