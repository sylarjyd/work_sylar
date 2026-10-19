import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './jwt.guard';
import type { JwtPayload } from './jwt';

/** 从已通过 JwtGuard 的请求中取当前用户（sub=userId、tenantId），供控制器做租户隔离。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);
