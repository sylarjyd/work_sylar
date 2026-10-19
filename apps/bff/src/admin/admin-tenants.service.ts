import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminCreditsRequest,
  AdminSubscribeRequest,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  BillingSummaryDto,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { BillingService } from '../billing/billing.service';
import { optionalString, parsePage } from './admin.util';

const MAX_ADJUST_AMOUNT = 1_000_000_000;

interface TenantRow {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
  subscription: { planId: string; status: string; plan: { name: string } } | null;
  credit: { balance: number; reserved: number } | null;
  _count: { users: number };
}

function toItem(row: TenantRow): AdminTenantItemDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    planId: row.subscription?.planId ?? 'free',
    planName: row.subscription?.plan.name ?? '—',
    subscriptionStatus: row.subscription?.status ?? 'none',
    balance: Math.max(0, (row.credit?.balance ?? 0) - (row.credit?.reserved ?? 0)),
    reserved: row.credit?.reserved ?? 0,
    userCount: row._count.users,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 管理端租户：分页检索、详情（含会话数与计费摘要）与套餐/积分调整，写操作与审计同事务。 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminTenantItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const q = optionalString(query.q);
    const planId = optionalString(query.planId);

    const where: Prisma.TenantWhereInput = {
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };

    // 先按订阅筛出租户 id 再过滤，列表与 total 使用同一 where。
    if (planId) {
      const subs = await this.prisma.subscription.findMany({
        where: { planId },
        select: { tenantId: true },
      });
      where.id = { in: subs.map((s) => s.tenantId) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        include: {
          subscription: { include: { plan: { select: { name: true } } } },
          credit: true,
          _count: { select: { users: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return { items: rows.map((r) => toItem(r as TenantRow)), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminTenantDetailDto> {
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: { include: { plan: { select: { name: true } } } },
        credit: true,
        _count: { select: { users: true } },
      },
    });
    if (!row) throw new NotFoundException('tenant_not_found');

    const [billing, sessionCount] = await Promise.all([
      this.billing.summary(id),
      this.prisma.session.count({ where: { tenantId: id } }),
    ]);

    // 租户详情属于敏感查看：审计失败只记日志，不阻断详情返回。
    await this.audit.bestEffort(actor, {
      action: 'tenant.view',
      targetType: 'tenant',
      targetId: id,
    });

    return { ...toItem(row as TenantRow), sessionCount, billing };
  }

  async subscribe(
    id: string,
    body: AdminSubscribeRequest,
    actor: AdminActor,
  ): Promise<BillingSummaryDto> {
    if (typeof body?.planId !== 'string' || body.planId === '') {
      throw new BadRequestException('invalid_plan');
    }
    await this.assertTenant(id);
    return this.billing.adminSubscribe(id, body.planId, new Date(), (tx) =>
      this.audit.write(tx, actor, {
        action: 'member.subscribe',
        targetType: 'tenant',
        targetId: id,
        summary: { planId: body.planId },
      }),
    );
  }

  async credits(
    id: string,
    body: AdminCreditsRequest,
    actor: AdminActor,
  ): Promise<BillingSummaryDto> {
    const amount = body?.amount;
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount === 0 ||
      Math.abs(amount) > MAX_ADJUST_AMOUNT
    ) {
      throw new BadRequestException('invalid_amount');
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'string') throw new BadRequestException('invalid_expires_at');
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('invalid_expires_at');
    }
    const note = typeof body.note === 'string' ? body.note : '';
    await this.assertTenant(id);
    return this.billing.adjust(id, amount, note, expiresAt, (tx) =>
      this.audit.write(tx, actor, {
        action: 'member.credits',
        targetType: 'tenant',
        targetId: id,
        summary: { amount, note, expiresAt: expiresAt?.toISOString() ?? null },
      }),
    );
  }

  private async assertTenant(id: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!tenant) throw new NotFoundException('tenant_not_found');
  }
}
