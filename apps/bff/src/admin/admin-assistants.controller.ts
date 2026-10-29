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
import type { AdminAssistantDto, PageDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminAssistantsService, type AdminAssistantInput } from './admin-assistants.service';

/** 运营端助手管理：列表区分公共内置与用户个人；公共助手可新建/编辑/删除。 */
@Controller('api/admin/assistants')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAssistantsController {
  constructor(private readonly assistants: AdminAssistantsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminAssistantDto>> {
    return this.assistants.list(query ?? {});
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: AdminAssistantInput,
  ): Promise<AdminAssistantDto> {
    return this.assistants.create(body ?? {}, { tenantId: user.tenantId, userId: user.sub }, actorOf(user, req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminAssistantInput,
  ): Promise<AdminAssistantDto> {
    return this.assistants.update(id, body ?? {}, actorOf(user, req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.assistants.remove(id, actorOf(user, req));
  }
}
