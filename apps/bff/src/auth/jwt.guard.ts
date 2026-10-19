import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { verifyToken, type JwtPayload } from './jwt';

export interface AuthedRequest extends FastifyRequest {
  user: JwtPayload;
}

/**
 * Bearer JWT 鉴权：验签成功后把 `{ sub, tenantId }` 挂到 req.user，供控制器与 AdminGuard 复用。
 * token 缺失或非法统一 401，不区分原因，避免给枚举者额外信号。
 */
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing_token');
    try {
      req.user = verifyToken(token);
    } catch {
      throw new UnauthorizedException('invalid_token');
    }
    return true;
  }
}
