import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan, Subscription } from '@prisma/client';
import type {
  BillingSummaryDto,
  CreditLedgerPageDto,
  PlanDto,
  RunBilling,
  UsageAggregateDto,
  UsageEvent,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { allocate } from './lots';
import { computeCredits } from './credits';
import { aggregateUsage, parseModels } from './usage';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from './billing.errors';
import { RATE_LIMITER, type RateLimiter } from './billing.rate-limit';

type Db = Prisma.TransactionClient;

const HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** 当前自然月（UTC）：月初到下月月初。 */
export function currentPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** 从 now 起一个月（UTC），用于管理员开通付费套餐。 */
function addMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()));
}

function toPlanDto(p: Plan): PlanDto {
  return {
    id: p.id,
    name: p.name,
    priceCents: p.priceCents,
    monthlyBaseCredits: p.monthlyBaseCredits,
    monthlyBonusCredits: p.monthlyBonusCredits,
    maxCreditsPerRun: p.maxCreditsPerRun,
    rpm: p.rpm,
    allowedModels: p.allowedModels,
  };
}

/**
 * 计费核心：套餐、授信、预占、结算、过期与查询。
 * 所有入口先 ensureSubscription（懒建/续期），保证存量租户无需迁移脚本。
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  // ------------------------------------------------------------------ 套餐与发放
  async ensureSubscription(tenantId: string): Promise<{ plan: Plan; sub: Subscription }> {
    const now = new Date();
    const existing = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!existing) return this.createFreeSubscription(tenantId, now);

    if (existing.periodEnd.getTime() > now.getTime()) return { plan: existing.plan, sub: existing };

    if (existing.planId !== 'free') {
      // 付费套餐过期：不自动续期，保留记录供用户查看。
      if (existing.status !== 'expired') {
        await this.prisma.subscription.update({ where: { tenantId }, data: { status: 'expired' } });
      }
      return { plan: existing.plan, sub: { ...existing, status: 'expired' } };
    }

    // free 自动续期：条件更新保证并发下只有一方发放。
    const { start, end } = currentPeriod(now);
    const renewed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.subscription.updateMany({
        where: { tenantId, periodEnd: { lte: now } },
        data: { status: 'active', periodStart: start, periodEnd: end },
      });
      if (res.count === 0) return null;
      await this.grantPeriod(tx, tenantId, existing.plan, start, end);
      return tx.subscription.findUnique({ where: { tenantId } });
    });
    if (renewed) return { plan: existing.plan, sub: renewed };
    const again = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    return again ? { plan: again.plan, sub: again } : { plan: existing.plan, sub: existing };
  }

  private async createFreeSubscription(
    tenantId: string,
    now: Date,
  ): Promise<{ plan: Plan; sub: Subscription }> {
    const plan = await this.requirePlan('free');
    const { start, end } = currentPeriod(now);
    try {
      const sub = await this.prisma.$transaction(async (tx) => {
        const created = await tx.subscription.create({
          data: { tenantId, planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
        });
        await this.grantPeriod(tx, tenantId, plan, start, end);
        return created;
      });
      return { plan, sub };
    } catch (err) {
      // 并发首次访问：另一方已创建并发放，直接回读。
      if ((err as { code?: string }).code === 'P2002') {
        const sub = await this.prisma.subscription.findUnique({
          where: { tenantId },
          include: { plan: true },
        });
        if (sub) return { plan: sub.plan, sub };
      }
      throw err;
    }
  }

  /** 发放一个周期的 base/bonus 积分，并累加租户余额。 */
  private async grantPeriod(
    tx: Db,
    tenantId: string,
    plan: Plan,
    start: Date,
    end: Date,
  ): Promise<void> {
    const grants = [
      { source: 'base', amount: plan.monthlyBaseCredits },
      { source: 'bonus', amount: plan.monthlyBonusCredits },
    ].filter((g) => g.amount > 0);
    if (grants.length === 0) return;

    let total = 0;
    for (const g of grants) {
      await tx.creditLot.create({
        data: {
          tenantId,
          source: g.source,
          granted: g.amount,
          remaining: g.amount,
          expiresAt: end,
          note: `period:${start.toISOString()}`,
        },
      });
      await tx.creditTx.create({
        data: { tenantId, type: 'grant', amount: g.amount, source: g.source, note: `period:${start.toISOString()}` },
      });
      total += g.amount;
    }
    await tx.tenantCredit.upsert({
      where: { tenantId },
      create: { tenantId, balance: total },
      update: { balance: { increment: total } },
    });
  }

  private async requirePlan(id: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new Error(`plan_missing:${id}`);
    return plan;
  }

  // ------------------------------------------------------------------ 预占与结算
  /** 运行前：校验套餐/限流/余额，锁行预占额度。返回给 runtime 的计费约束。 */
  async beginRun(runId: string, tenantId: string): Promise<RunBilling> {
    const { plan, sub } = await this.ensureSubscription(tenantId);
    if (sub.status !== 'active' || sub.periodEnd.getTime() <= Date.now()) {
      throw new PlanExpiredError();
    }
    const rl = await this.limiter.hit(`run:${tenantId}`, plan.rpm);
    if (!rl.allowed) throw new RateLimitedError(rl.retryAfter);

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
      await this.lockCredit(tx, tenantId);
      await this.expireDueLots(tx, tenantId, now);
      const credit = await tx.tenantCredit.findUnique({ where: { tenantId } });
      const available = (credit?.balance ?? 0) - (credit?.reserved ?? 0);
      if (available < 1) throw new InsufficientCreditsError();

      const amount = Math.min(plan.maxCreditsPerRun, available);
      await tx.creditHold.create({
        data: { runId, tenantId, amount, expiresAt: new Date(now.getTime() + HOLD_TTL_MS) },
      });
      await tx.tenantCredit.update({
        where: { tenantId },
        data: { reserved: { increment: amount } },
      });
      const prices = await this.loadPrices(tx);
      // 价格表漏配会让 runtime 按 0 计费并绕过预算，属于配置错误，入口直接拒绝。
      for (const model of plan.allowedModels) {
        if (!prices[model]) throw new Error(`model_price_missing:${model}`);
      }
      return { maxCredits: amount, allowedModels: plan.allowedModels, prices };
    });
  }

  /** 记录累计用量；已存在则仅在 pending 时更新（保持幂等）。 */
  async recordUsage(
    runId: string,
    meta: { tenantId: string; userId: string; sessionId: string },
    usage: UsageEvent,
  ): Promise<void> {
    const data = {
      models: usage.models as unknown as Prisma.InputJsonValue,
      inputTokens: usage.input,
      outputTokens: usage.output,
      status: 'pending',
    };
    const existing = await this.prisma.usageRecord.findUnique({ where: { runId } });
    if (existing) {
      if (existing.status === 'pending') {
        await this.prisma.usageRecord.update({ where: { runId }, data });
      }
      return;
    }
    await this.prisma.usageRecord.create({ data: { runId, ...meta, ...data } });
  }

  /** 结算：按价格折算积分，按到期顺序扣批次，释放预占；runId 唯一保证幂等。 */
  async settle(runId: string): Promise<void> {
    const usage = await this.prisma.usageRecord.findUnique({ where: { runId } });
    if (!usage || usage.status !== 'pending') return;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({
        where: { tenantId: usage.tenantId },
        create: { tenantId: usage.tenantId },
        update: {},
      });
      await this.lockCredit(tx, usage.tenantId);

      const hold = await tx.creditHold.findUnique({ where: { runId } });
      const models = parseModels(usage.models);
      const prices = await this.loadPrices(tx);
      // 有 hold 时封顶在预占额度；无 hold（异常兜底）则按实际用量。
      const credits = computeCredits(models, prices, hold?.amount ?? Number.MAX_SAFE_INTEGER);

      const now = new Date();
      await this.expireDueLots(tx, usage.tenantId, now);
      const lots = await tx.creditLot.findMany({
        where: { tenantId: usage.tenantId, remaining: { gt: 0 } },
      });
      const { allocations, deducted } = allocate(lots, credits);
      for (const a of allocations) {
        await tx.creditLot.update({
          where: { id: a.lotId },
          data: { remaining: { decrement: a.amount } },
        });
      }
      await tx.creditTx.create({
        data: {
          tenantId: usage.tenantId,
          type: 'consume',
          amount: -deducted,
          source: 'usage',
          runId,
          note: `run:${runId}`,
        },
      });
      await tx.tenantCredit.update({
        where: { tenantId: usage.tenantId },
        data: {
          balance: { decrement: deducted },
          ...(hold ? { reserved: { decrement: hold.amount } } : {}),
        },
      });
      if (hold) await tx.creditHold.delete({ where: { runId } });
      await tx.usageRecord.update({
        where: { runId },
        data: { credits: deducted, status: 'settled', settledAt: now },
      });
      if (deducted < credits) {
        console.warn(`[billing] run ${runId} 可用积分不足：应扣 ${credits}，实扣 ${deducted}`);
      }
    });
  }

  /** 运行失败/无用量：只归还预占，不扣费。 */
  async releaseHold(runId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({ where: { runId } });
      if (!hold) return;
      await tx.tenantCredit.upsert({
        where: { tenantId: hold.tenantId },
        create: { tenantId: hold.tenantId },
        update: {},
      });
      await this.lockCredit(tx, hold.tenantId);
      await tx.tenantCredit.update({
        where: { tenantId: hold.tenantId },
        data: { reserved: { decrement: hold.amount } },
      });
      await tx.creditHold.delete({ where: { runId } });
    });
  }

  // ------------------------------------------------------------------ 查询
  async listPlans(): Promise<PlanDto[]> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      orderBy: { priceCents: 'asc' },
    });
    return plans.map(toPlanDto);
  }

  async summary(tenantId: string): Promise<BillingSummaryDto> {
    const { plan, sub } = await this.ensureSubscription(tenantId);
    const credit = await this.prisma.tenantCredit.findUnique({ where: { tenantId } });
    const next = await this.prisma.creditLot.findFirst({
      where: { tenantId, remaining: { gt: 0 }, expiresAt: { not: null } },
      orderBy: { expiresAt: 'asc' },
    });
    return {
      plan: toPlanDto(plan),
      subscription: {
        status: sub.status,
        periodStart: sub.periodStart.toISOString(),
        periodEnd: sub.periodEnd.toISOString(),
      },
      balance: Math.max(0, (credit?.balance ?? 0) - (credit?.reserved ?? 0)),
      reserved: credit?.reserved ?? 0,
      nextExpiry: next?.expiresAt
        ? { amount: next.remaining, expiresAt: next.expiresAt.toISOString() }
        : null,
    };
  }

  async ledger(tenantId: string, limit: number, cursor?: string): Promise<CreditLedgerPageDto> {
    const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    const cursorRow = cursor
      ? await this.prisma.creditTx.findUnique({ where: { id: cursor } })
      : null;
    const rows = await this.prisma.creditTx.findMany({
      where: {
        tenantId,
        ...(cursorRow
          ? {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const items = rows.slice(0, take).map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      source: t.source,
      runId: t.runId,
      note: t.note,
      createdAt: t.createdAt.toISOString(),
    }));
    return {
      items,
      nextCursor: rows.length > take ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async usage(
    tenantId: string,
    from: Date,
    to: Date,
    groupBy: 'day' | 'model',
  ): Promise<UsageAggregateDto[]> {
    const rows = await this.prisma.usageRecord.findMany({
      where: { tenantId, status: 'settled', createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'asc' },
    });
    return aggregateUsage(
      rows.map((r) => ({
        createdAt: r.createdAt,
        credits: r.credits,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        models: r.models,
      })),
      groupBy,
      await this.loadPrices(this.prisma),
    );
  }

  // ------------------------------------------------------------------ 管理操作
  async adminSubscribe(tenantId: string, planId: string, now = new Date()): Promise<BillingSummaryDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.active) throw new NotFoundException('plan_not_found');
    if (plan.id === 'free') throw new BadRequestException('free_not_subscribable');

    const start = now;
    const end = addMonth(now);
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.upsert({
        where: { tenantId },
        create: { tenantId, planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
        update: { planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
      });
      await this.grantPeriod(tx, tenantId, plan, start, end);
    });
    return this.summary(tenantId);
  }

  async adjust(
    tenantId: string,
    amount: number,
    note: string,
    expiresAt: Date | null,
  ): Promise<BillingSummaryDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
      await this.lockCredit(tx, tenantId);

      if (amount > 0) {
        await tx.creditLot.create({
          data: { tenantId, source: 'adjust', granted: amount, remaining: amount, expiresAt, note },
        });
        await tx.creditTx.create({
          data: { tenantId, type: 'adjust', amount, source: 'adjust', note },
        });
        await tx.tenantCredit.update({
          where: { tenantId },
          data: { balance: { increment: amount } },
        });
        return;
      }

      const target = -amount;
      const credit = await tx.tenantCredit.findUnique({ where: { tenantId } });
      if ((credit?.balance ?? 0) - (credit?.reserved ?? 0) < target) {
        throw new BadRequestException('insufficient_balance');
      }
      const lots = await tx.creditLot.findMany({
        where: { tenantId, remaining: { gt: 0 } },
      });
      const { allocations, deducted } = allocate(lots, target);
      if (deducted < target) throw new BadRequestException('insufficient_balance');
      for (const a of allocations) {
        await tx.creditLot.update({
          where: { id: a.lotId },
          data: { remaining: { decrement: a.amount } },
        });
      }
      await tx.creditTx.create({
        data: { tenantId, type: 'adjust', amount: -deducted, source: 'adjust', note },
      });
      await tx.tenantCredit.update({
        where: { tenantId },
        data: { balance: { decrement: deducted } },
      });
    });
    return this.summary(tenantId);
  }

  // ------------------------------------------------------------------ 补偿
  /** 结算超过 olderThan 仍 pending 的用量；单条失败不阻断其余。 */
  async settleStalePending(olderThan: Date): Promise<void> {
    const rows = await this.prisma.usageRecord.findMany({
      where: { status: 'pending', createdAt: { lt: olderThan } },
      select: { runId: true },
      take: 100,
    });
    for (const row of rows) {
      try {
        await this.settle(row.runId);
      } catch (err) {
        console.error(`[billing] 补偿结算失败 run=${row.runId}: ${(err as Error).message}`);
      }
    }
  }

  /** 扫描所有租户的过期批次并清零。 */
  async sweepExpired(now = new Date()): Promise<void> {
    const tenants = await this.prisma.creditLot.findMany({
      where: { expiresAt: { lte: now }, remaining: { gt: 0 } },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    for (const { tenantId } of tenants) {
      await this.prisma.$transaction(async (tx) => {
        await this.lockCredit(tx, tenantId);
        await this.expireDueLots(tx, tenantId, now);
      });
    }
  }

  /** 清理超过 TTL 的预占：有 pending 用量先结算，否则释放；run 仍在跑则保留。 */
  async sweepOrphanHolds(now = new Date()): Promise<void> {
    const holds = await this.prisma.creditHold.findMany({
      where: { expiresAt: { lte: now } },
    });
    for (const hold of holds) {
      const usage = await this.prisma.usageRecord.findUnique({ where: { runId: hold.runId } });
      if (usage?.status === 'pending') {
        try {
          await this.settle(hold.runId);
        } catch (err) {
          console.error(`[billing] 孤儿预占结算失败 run=${hold.runId}: ${(err as Error).message}`);
        }
        continue;
      }
      const run = await this.prisma.run.findUnique({
        where: { id: hold.runId },
        select: { status: true },
      });
      if (!run || run.status !== 'running') await this.releaseHold(hold.runId);
    }
  }

  // ------------------------------------------------------------------ 内部工具
  private async lockCredit(tx: Db, tenantId: string): Promise<void> {
    await tx.$queryRaw`SELECT "tenantId" FROM "TenantCredit" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
  }

  private async expireDueLots(tx: Db, tenantId: string, now: Date): Promise<void> {
    const lots = await tx.creditLot.findMany({
      where: { tenantId, remaining: { gt: 0 }, expiresAt: { lte: now } },
    });
    if (lots.length === 0) return;
    let expired = 0;
    for (const lot of lots) {
      await tx.creditLot.update({ where: { id: lot.id }, data: { remaining: 0 } });
      await tx.creditTx.create({
        data: { tenantId, type: 'expire', amount: -lot.remaining, source: lot.source },
      });
      expired += lot.remaining;
    }
    await tx.tenantCredit.update({
      where: { tenantId },
      data: { balance: { decrement: expired } },
    });
  }

  private async loadPrices(
    client: Db | PrismaService,
  ): Promise<Record<string, { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number }>> {
    const rows = await client.modelPrice.findMany();
    return Object.fromEntries(
      rows.map((r) => [
        r.model,
        {
          inputMilliCreditsPer1k: r.inputMilliCreditsPer1k,
          outputMilliCreditsPer1k: r.outputMilliCreditsPer1k,
        },
      ]),
    );
  }
}
