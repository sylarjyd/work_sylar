import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminQaCacheListDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminQaCacheService } from './admin-qa-cache.service';

/** 运营端问答缓存接口：未过期条目分页与按 hash 删除，统一要求管理员角色。 */
@Controller('api/admin/qa-cache')
@UseGuards(JwtGuard, AdminGuard)
export class AdminQaCacheController {
  constructor(private readonly cache: AdminQaCacheService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<AdminQaCacheListDto> {
    return this.cache.list(query ?? {});
  }

  @Delete(':hash')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('hash') hash: string,
  ): Promise<void> {
    await this.cache.remove(hash, actorOf(user, req));
  }
}
