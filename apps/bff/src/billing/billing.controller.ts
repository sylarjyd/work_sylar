import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { BillingSummaryDto, PlanDto, CreditLedgerPageDto, UsageAggregateDto } from '@ai-office/shared';
import { BillingService } from './billing.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

/** 用户侧计费查询：套餐目录、余额、流水、按日/模型用量。 */
@Controller('api/billing')
@UseGuards(JwtGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  plans(): Promise<PlanDto[]> {
    return this.billing.listPlans();
  }

  @Get('summary')
  summary(@CurrentUser() user: JwtPayload): Promise<BillingSummaryDto> {
    return this.billing.summary(user.tenantId);
  }

  @Get('ledger')
  ledger(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<CreditLedgerPageDto> {
    // 重复 query 参数会以数组到达，asString 归一化后非字符串一律视为未提供。
    const limitValue = asString(limit);
    const cursorValue = asString(cursor);
    return this.billing.ledger(
      user.tenantId,
      Number(limitValue ?? 20),
      cursorValue,
    );
  }

  @Get('usage')
  usage(
    @CurrentUser() user: JwtPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
  ): Promise<UsageAggregateDto[]> {
    const now = new Date();
    let fromDate = parseDate(from) ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const toDate = parseDate(to) ?? now;
    if (fromDate > toDate) throw new BadRequestException('invalid_range');
    // 区间上限 365 天，避免一次查询拉取过多用量记录。
    const minFrom = new Date(toDate.getTime() - 365 * 24 * 60 * 60 * 1000);
    if (fromDate < minFrom) fromDate = minFrom;
    return this.billing.usage(user.tenantId, fromDate, toDate, groupBy === 'model' ? 'model' : 'day');
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
