import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import type {
  CreateSessionRequest,
  MessageDto,
  SessionPage,
  SessionSummary,
} from '@ai-office/shared';

/** 会话入口：所有读写都带 tenantId + userId 过滤，跨用户访问由 service 层按 404 处理。 */
@Controller('api/sessions')
@UseGuards(JwtGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SessionPage> {
    return this.sessions.list(user.tenantId, user.sub, {
      // 非法数值交给 service 归一到默认页大小，不让翻页参数把首屏打挂。
      limit: limit === undefined ? undefined : Number(limit),
      cursor: typeof cursor === 'string' ? cursor : undefined,
    });
  }

  @Get(':id')
  detail(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SessionSummary> {
    return this.sessions.detail(id, user.tenantId, user.sub);
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() body: CreateSessionRequest,
  ): Promise<SessionSummary> {
    return this.sessions.create(user.tenantId, user.sub, body ?? {});
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<MessageDto[]> {
    return this.sessions.messages(id, user.tenantId, user.sub);
  }
}
