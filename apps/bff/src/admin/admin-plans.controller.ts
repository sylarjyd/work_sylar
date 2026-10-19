import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminPlanDto, AdminPlanInput, AdminPlanPatch } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminPlansService } from './admin-plans.service';

/** 管理端套餐接口：目录读取、新建与局部更新，统一要求管理员角色。 */
@Controller('api/admin/plans')
@UseGuards(JwtGuard, AdminGuard)
export class AdminPlansController {
  constructor(private readonly plans: AdminPlansService) {}

  @Get()
  list(): Promise<AdminPlanDto[]> {
    return this.plans.listAll();
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: AdminPlanInput,
  ): Promise<AdminPlanDto> {
    return this.plans.create(body, actorOf(user, req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminPlanPatch,
  ): Promise<AdminPlanDto> {
    return this.plans.update(id, body ?? {}, actorOf(user, req));
  }
}
