import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './jwt.guard';
import type { JwtPayload } from './jwt';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);
