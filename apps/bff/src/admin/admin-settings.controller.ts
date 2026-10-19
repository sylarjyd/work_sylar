import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminSettingDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { SettingsService } from '../settings/settings.service';

/** 管理端参数接口：读取当前生效值、按 key 更新与恢复默认，统一要求管理员角色。 */
@Controller('api/admin/settings')
@UseGuards(JwtGuard, AdminGuard)
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list(): Promise<AdminSettingDto[]> {
    return this.settings.getAll();
  }

  @Put(':key')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('key') key: string,
    @Body() body: { value?: unknown },
  ): Promise<AdminSettingDto> {
    if (!body || body.value === undefined) throw new BadRequestException('invalid_value');
    return this.settings.update(key, body.value, actorOf(user, req));
  }

  @Delete(':key')
  @HttpCode(204)
  async reset(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('key') key: string,
  ): Promise<void> {
    await this.settings.reset(key, actorOf(user, req));
  }
}
