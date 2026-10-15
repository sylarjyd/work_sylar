import { describe, it, expect, beforeAll } from 'vitest';
import { signToken, verifyToken } from './jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

describe('jwt', () => {
  it('签发后能校验回原 payload', () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    expect(verifyToken(token)).toMatchObject({ sub: 'u1', tenantId: 't1' });
  });

  it('被篡改的 token 校验失败', () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    expect(() => verifyToken(token + 'x')).toThrow();
  });
});
