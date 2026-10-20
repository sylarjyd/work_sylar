import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminTasksService } from './admin-tasks.service';

/** 管理端任务与运行接口：跨租户只读，统一要求管理员角色。 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminTasksController {
  constructor(private readonly tasks: AdminTasksService) {}

  @Get('tasks')
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminTaskItemDto>> {
    return this.tasks.list(query ?? {});
  }

  @Get('tasks/:id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminTaskDetailDto> {
    return this.tasks.detail(id, actorOf(user, req));
  }

  @Get('runs/:id')
  runDetail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminRunDetailDto> {
    return this.tasks.runDetail(id, query ?? {}, actorOf(user, req));
  }

  @Get('runs/:id/timeline')
  runTimeline(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminRunTimelineDto> {
    return this.tasks.runTimeline(id, actorOf(user, req));
  }
}
