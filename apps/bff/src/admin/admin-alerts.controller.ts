import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminAlertEventDto,
  AdminAlertRuleDto,
  AdminAlertTestResultDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminAlertsService } from './admin-alerts.service';

/** 管理端告警：规则编辑、事件检索与测试投递。 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAlertsController {
  constructor(private readonly alerts: AdminAlertsService) {}

  @Get('alert-rules')
  listRules(): Promise<AdminAlertRuleDto[]> {
    return this.alerts.listRules();
  }

  @Patch('alert-rules/:id')
  updateRule(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminAlertRuleDto> {
    return this.alerts.updateRule(id, body, actorOf(user, req));
  }

  @Get('alert-events')
  listEvents(@Query() query: Record<string, unknown>): Promise<PageDto<AdminAlertEventDto>> {
    return this.alerts.listEvents(query ?? {});
  }

  @Post('alert-rules/:id/test')
  sendTest(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminAlertTestResultDto> {
    return this.alerts.sendTest(id, actorOf(user, req));
  }
}
