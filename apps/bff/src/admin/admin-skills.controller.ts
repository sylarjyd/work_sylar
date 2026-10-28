import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { PageDto, SkillDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminSkillsService } from './admin-skills.service';

/** 运营端技能管理：列表区分公共/个人，公共技能可增删改与启停，个人技能只读。 */
@Controller('api/admin/skills')
@UseGuards(JwtGuard, AdminGuard)
export class AdminSkillsController {
  constructor(private readonly skills: AdminSkillsService) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PageDto<SkillDto>> {
    return this.skills.list(query ?? {}, actorOf(user, req));
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.create(body, actorOf(user, req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.update(id, body, actorOf(user, req));
  }

  @Post(':id/enabled')
  setEnabled(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { enabled?: unknown },
  ): Promise<SkillDto> {
    return this.skills.setEnabled(id, body?.enabled === true, actorOf(user, req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.skills.remove(id, actorOf(user, req));
  }
}
