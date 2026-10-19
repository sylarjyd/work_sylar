import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthedRequest } from './jwt.guard';

/**
 * 管理员校验：只读 JwtGuard 回填的 role，不再查库。
 * **须置于 JwtGuard 之后**（`@UseGuards(JwtGuard, AdminGuard)`）。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Partial<AuthedRequest>>();
    if (req.user?.role !== 'admin') throw new ForbiddenException('not_admin');
    return true;
  }
}
