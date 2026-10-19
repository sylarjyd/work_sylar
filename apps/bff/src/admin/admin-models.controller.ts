import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminModelPriceDto, AdminModelsDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminModelsService } from './admin-models.service';

/** 管理端模型接口：目录读取与价格 CRUD，统一要求管理员角色。 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminModelsController {
  constructor(private readonly models: AdminModelsService) {}

  @Get('models')
  catalog(): Promise<AdminModelsDto> {
    return this.models.catalog();
  }

  @Post('model-prices')
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelPriceDto> {
    return this.models.create(body ?? {}, actorOf(user, req));
  }

  @Patch('model-prices/:model')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelPriceDto> {
    return this.models.update(model, body ?? {}, actorOf(user, req));
  }

  @Delete('model-prices/:model')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('model') model: string,
  ): Promise<void> {
    await this.models.remove(model, actorOf(user, req));
  }
}
