import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { verifyToken, type JwtPayload } from './jwt';

export interface AuthedRequest extends FastifyRequest {
  user: JwtPayload;
}

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
