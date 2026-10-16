import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { AuthedRequest } from './jwt.guard';

/**
 * 管理员校验：由 JWT `sub` 查库取 `role`（不入 JWT，改角色无需重发 token）。
 * **须置于 JwtGuard 之后**（`@UseGuards(JwtGuard, AdminGuard)`），依赖其已填充 req.user。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Partial<AuthedRequest>>();
    const sub = req.user?.sub;
    if (!sub) throw new ForbiddenException('not_admin');
    const user = await this.prisma.user.findUnique({ where: { id: sub }, select: { role: true } });
    if (user?.role !== 'admin') throw new ForbiddenException('not_admin');
    return true;
  }
}
