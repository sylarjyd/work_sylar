import {
  BadRequestException,
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
  AdminMessageDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminSessionsService } from './admin-sessions.service';

/** 管理端会话接口：跨租户列表/详情/消息与归档，统一要求管理员角色。 */
@Controller('api/admin/sessions')
@UseGuards(JwtGuard, AdminGuard)
export class AdminSessionsController {
  constructor(private readonly sessions: AdminSessionsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminSessionItemDto>> {
    return this.sessions.list(query ?? {});
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminSessionDetailDto> {
    return this.sessions.detail(id, actorOf(user, req));
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PageDto<AdminMessageDto>> {
    return this.sessions.messages(id, query ?? {}, actorOf(user, req));
  }

  @Patch(':id')
  archive(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { status?: unknown },
  ): Promise<AdminSessionItemDto> {
    if (body?.status !== 'archived') throw new BadRequestException('invalid_status');
    return this.sessions.archive(id, actorOf(user, req));
  }
}
