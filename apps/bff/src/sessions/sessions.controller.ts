import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import type {
  CreateSessionRequest,
  MessageDto,
  SessionSummary,
} from '@ai-office/shared';

/** 会话入口：所有读写都带 tenantId + userId 过滤，跨用户访问由 service 层按 404 处理。 */
@Controller('api/sessions')
@UseGuards(JwtGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<SessionSummary[]> {
    return this.sessions.list(user.tenantId, user.sub);
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
