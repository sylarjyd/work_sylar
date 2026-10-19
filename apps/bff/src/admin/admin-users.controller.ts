import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminUsersService } from './admin-users.service';

/** 管理端用户接口：列表/详情/变更，统一要求管理员角色。 */
@Controller('api/admin/users')
@UseGuards(JwtGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminUserItemDto>> {
    return this.users.list(query ?? {});
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminUserDetailDto> {
    return this.users.detail(id, actorOf(user, req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminUserPatch,
  ): Promise<AdminUserItemDto> {
    return this.users.update(id, body ?? {}, actorOf(user, req));
  }
}
