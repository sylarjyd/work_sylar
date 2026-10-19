import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { BillingSummaryDto } from '@ai-office/shared';
import { BillingService } from './billing.service';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

/** 管理操作：开通/续期套餐、调整积分；仅作用于调用者所在租户。 */
@Controller('api/billing/admin')
@UseGuards(JwtGuard, AdminGuard)
export class BillingAdminController {
  constructor(private readonly billing: BillingService) {}

  @Post('subscribe')
  subscribe(
    @CurrentUser() user: JwtPayload,
    @Body() body: { planId?: unknown },
  ): Promise<BillingSummaryDto> {
    if (typeof body?.planId !== 'string' || body.planId === '') {
      throw new BadRequestException('invalid_plan');
    }
    return this.billing.adminSubscribe(user.tenantId, body.planId);
  }

  @Post('credits')
  credits(
    @CurrentUser() user: JwtPayload,
    @Body() body: { amount?: unknown; note?: unknown; expiresAt?: unknown },
  ): Promise<BillingSummaryDto> {
    if (typeof body?.amount !== 'number' || !Number.isInteger(body.amount) || body.amount === 0) {
      throw new BadRequestException('invalid_amount');
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'string') throw new BadRequestException('invalid_expires_at');
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('invalid_expires_at');
    }
    const note = typeof body.note === 'string' ? body.note : '';
    return this.billing.adjust(user.tenantId, body.amount, note, expiresAt);
  }
}
