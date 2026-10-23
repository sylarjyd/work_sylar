import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminKbBaseDetailDto,
  AdminKbBaseItemDto,
  AdminKbDeleteInput,
  AdminKbDocDeleteInput,
  AdminKbStatsDto,
  KbDeleteResultDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminKbService } from './admin-kb.service';

/** 管理端知识库接口：跨租户查看、统计与带确认的删除，统一要求管理员角色。 */
@Controller('api/admin/kb')
@UseGuards(JwtGuard, AdminGuard)
export class AdminKbController {
  constructor(private readonly kb: AdminKbService) {}

  @Get('stats')
  stats(): Promise<AdminKbStatsDto> {
    return this.kb.stats();
  }

  @Get('bases')
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminKbBaseItemDto>> {
    return this.kb.list(query ?? {});
  }

  @Get('bases/:id')
  detail(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminKbBaseDetailDto> {
    return this.kb.detail(id, query ?? {});
  }

  @Delete('bases/:id')
  deleteBase(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminKbDeleteInput,
  ): Promise<KbDeleteResultDto> {
    return this.kb.deleteBase(id, body, actorOf(user, req));
  }

  @Delete('bases/:baseId/docs/:docId')
  deleteDoc(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('baseId') baseId: string,
    @Param('docId') docId: string,
    @Body() body: AdminKbDocDeleteInput,
  ): Promise<KbDeleteResultDto> {
    return this.kb.deleteDoc(baseId, docId, body, actorOf(user, req));
  }
}
