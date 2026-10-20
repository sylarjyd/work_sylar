import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminMetricTimeseriesDto, AdminOverviewDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AdminObservabilityService } from './admin-observability.service';

/** 管理端概览与指标序列：跨租户聚合数据，统一要求管理员角色。 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminObservabilityController {
  constructor(private readonly observability: AdminObservabilityService) {}

  @Get('overview')
  overview(@Query() query: Record<string, unknown>): Promise<AdminOverviewDto> {
    return this.observability.overview(query ?? {});
  }

  @Get('metrics/timeseries')
  timeseries(@Query() query: Record<string, unknown>): Promise<AdminMetricTimeseriesDto> {
    return this.observability.timeseries(query ?? {});
  }
}
