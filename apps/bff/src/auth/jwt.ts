import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  tenantId: string;
}

/** 每次调用读取 env：测试在 beforeAll 里设置 JWT_SECRET，模块级读取会拿到旧值。 */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET 未设置');
  return s;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret()) as JwtPayload;
}
