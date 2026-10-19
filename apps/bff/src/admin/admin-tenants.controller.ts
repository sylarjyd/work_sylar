import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminCreditsRequest,
  AdminSubscribeRequest,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  BillingSummaryDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminTenantsService } from './admin-tenants.service';

/** 管理端租户接口：列表/详情/开通套餐/调整积分，统一要求管理员角色。 */
@Controller('api/admin/tenants')
@UseGuards(JwtGuard, AdminGuard)
export class AdminTenantsController {
  constructor(private readonly tenants: AdminTenantsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminTenantItemDto>> {
    return this.tenants.list(query ?? {});
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminTenantDetailDto> {
    return this.tenants.detail(id, actorOf(user, req));
  }

  @Post(':id/subscribe')
  @HttpCode(200)
  subscribe(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminSubscribeRequest,
  ): Promise<BillingSummaryDto> {
    return this.tenants.subscribe(id, body, actorOf(user, req));
  }

  @Post(':id/credits')
  @HttpCode(200)
  credits(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminCreditsRequest,
  ): Promise<BillingSummaryDto> {
    return this.tenants.credits(id, body, actorOf(user, req));
  }
}
