import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  /** 以下字段由 JwtGuard 查库回填，签名 payload 中不含。 */
  role?: string;
  email?: string;
}

/** 每次调用读取 env：测试在 beforeAll 里设置 JWT_SECRET，模块级读取会拿到旧值。 */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET 未设置');
  return s;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(
    { sub: payload.sub, tenantId: payload.tenantId },
    secret(),
    { algorithm: 'HS256', expiresIn: '7d' },
  );
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret(), { algorithms: ['HS256'] }) as JwtPayload;
}
