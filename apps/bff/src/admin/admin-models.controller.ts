import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminModelDto,
  AdminModelProviderDto,
  AdminModelsDto,
  AdminModelTestResultDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminModelsService } from './admin-models.service';

/**
 * 管理端模型接口。模型名可能包含 `/`，因此更新/删除使用请求体/查询参数，
 * 不把模型名放进路径，避免编码差异导致路由不匹配。
 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminModelsController {
  constructor(private readonly models: AdminModelsService) {}

  @Get('models')
  catalog(): Promise<AdminModelsDto> {
    return this.models.catalog();
  }

  @Post('model-providers')
  createProvider(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelProviderDto> {
    return this.models.createProvider(body ?? {}, actorOf(user, req));
  }

  @Patch('model-providers/:id')
  updateProvider(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelProviderDto> {
    return this.models.updateProvider(id, body ?? {}, actorOf(user, req));
  }

  @Delete('model-providers/:id')
  @HttpCode(204)
  async removeProvider(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.models.removeProvider(id, actorOf(user, req));
  }

  @Post('models')
  createModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelDto> {
    return this.models.createModel(body ?? {}, actorOf(user, req));
  }

  @Patch('models')
  updateModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelDto> {
    return this.models.updateModel(body ?? {}, actorOf(user, req));
  }

  @Delete('models')
  @HttpCode(204)
  async removeModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Query('model') model: string,
  ): Promise<void> {
    await this.models.removeModel(model, actorOf(user, req));
  }

  @Post('models/test')
  testModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelTestResultDto> {
    return this.models.testModel(body ?? {}, actorOf(user, req));
  }

  @Put('default-model')
  setDefault(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelsDto> {
    return this.models.setDefault(body ?? {}, actorOf(user, req));
  }
}
