import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { addSpanAttributes, updateContext } from '@ai-office/telemetry';
import { PrismaService } from '../db/prisma.service';
import { verifyToken, type JwtPayload } from './jwt';

export interface AuthedRequest extends FastifyRequest {
  user: JwtPayload;
}

/**
 * Bearer JWT 鉴权：验签后按 sub 查库，要求用户存在且 status=active，
 * 再把库中的 tenantId/role/email 挂到 req.user。
 * 禁用立即生效（含已签发 token），角色变更无需重发 token。
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing_token');

    let payload: JwtPayload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new UnauthorizedException('invalid_token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, role: true, tenantId: true, email: true },
    });
    // 不存在/禁用统一 invalid_token，避免给攻击者额外信号。
    if (!user || user.status !== 'active') throw new UnauthorizedException('invalid_token');

    req.user = {
      sub: payload.sub,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    };
    // 鉴权在 onRequest 之后执行：这里把用户/租户回填进 ALS，后续日志自动带上；
    // span 属性只放稳定 ID，不放邮箱等 PII。
    updateContext({ userId: payload.sub, tenantId: user.tenantId });
    addSpanAttributes({ 'enduser.id': payload.sub, 'tenant.id': user.tenantId });
    return true;
  }
}
