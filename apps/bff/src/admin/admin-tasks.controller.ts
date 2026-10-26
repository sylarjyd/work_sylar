import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  CancelRunResultDto,
  PageDto,
  RetryRunResultDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { QueueFullError } from '../queue/run-queue.service';
import { AdminTasksService } from './admin-tasks.service';

/** 管理端任务与运行接口：跨租户查看与运营操作（取消/重试），统一要求管理员角色。 */
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

  @Post('runs/:id/cancel')
  @HttpCode(200)
  cancelRun(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CancelRunResultDto> {
    return this.tasks.cancelRun(id, actorOf(user, req));
  }

  @Post('runs/:id/retry')
  @HttpCode(202)
  async retryRun(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<RetryRunResultDto> {
    try {
      return await this.tasks.retryRun(id, actorOf(user, req));
    } catch (err) {
      // 管理端前端按 Nest 的 message 字段识别业务码，这里统一成 429 queue_full。
      if (err instanceof QueueFullError) {
        throw new HttpException('queue_full', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw err;
    }
  }
}
