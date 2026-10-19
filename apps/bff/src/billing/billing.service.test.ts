import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { BillingService } from './billing.service';
import { InsufficientCreditsError } from './billing.errors';
import { PrismaService } from '../db/prisma.service';

type Row = Record<string, any>;

const NOW = new Date('2026-10-19T08:00:00Z');

function makeDb() {
  const db = {
    plans: [] as Row[],
    subs: [] as Row[],
    lots: [] as Row[],
    txs: [] as Row[],
    credits: [] as Row[],
    holds: [] as Row[],
    usages: [] as Row[],
    prices: [] as Row[],
  };

  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else if (v && typeof v === 'object' && 'decrement' in v) row[k] = (row[k] ?? 0) - (v as any).decrement;
      else row[k] = v;
    }
    return row;
  };

  const client: any = {
    plan: {
      findUnique: async ({ where }: any) => db.plans.find((p) => p.id === where.id) ?? null,
      findMany: async () => [...db.plans].filter((p) => p.active).sort((a, b) => a.priceCents - b.priceCents),
    },
    subscription: {
      findUnique: async ({ where }: any) => {
        const sub = db.subs.find((s) => s.tenantId === where.tenantId);
        return sub ? { ...sub, plan: db.plans.find((p) => p.id === sub.planId) } : null;
      },
      create: async ({ data }: any) => {
        if (db.subs.some((s) => s.tenantId === data.tenantId)) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `sub${db.subs.length + 1}`, ...data };
        db.subs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => apply(db.subs.find((s) => s.tenantId === where.tenantId)!, data),
      upsert: async ({ where, create, update }: any) => {
        const row = db.subs.find((s) => s.tenantId === where.tenantId);
        if (row) return apply(row, update);
        const created = { id: `sub${db.subs.length + 1}`, ...create };
        db.subs.push(created);
        return created;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = db.subs.filter(
          (s) => s.tenantId === where.tenantId && (!where.periodEnd?.lte || s.periodEnd <= where.periodEnd.lte),
        );
        targets.forEach((s) => apply(s, data));
        return { count: targets.length };
      },
    },
    tenantCredit: {
      upsert: async ({ where, create }: any) => {
        let row = db.credits.find((c) => c.tenantId === where.tenantId);
        if (!row) {
          row = { balance: 0, reserved: 0, ...create };
          db.credits.push(row);
        }
        return row;
      },
      findUnique: async ({ where }: any) => db.credits.find((c) => c.tenantId === where.tenantId) ?? null,
      update: async ({ where, data }: any) => apply(db.credits.find((c) => c.tenantId === where.tenantId)!, data),
    },
    creditLot: {
      create: async ({ data }: any) => {
        const row = { id: `lot${db.lots.length + 1}`, ...data };
        db.lots.push(row);
        return row;
      },
      // 返回副本：Prisma 查询结果是快照，避免 update 后就地修改影响已读取的行。
      findMany: async ({ where }: any) =>
        db.lots
          .filter(
            (l) =>
              (!where.tenantId || l.tenantId === where.tenantId) &&
              (!where.remaining?.gt || l.remaining > where.remaining.gt) &&
              (!where.expiresAt?.lte || (l.expiresAt && l.expiresAt <= where.expiresAt.lte)),
          )
          .map((l) => ({ ...l })),
      findFirst: async ({ where }: any) => {
        const rows = db.lots
          .filter((l) => l.tenantId === where.tenantId)
          .filter((l) => !where.remaining?.gt || l.remaining > where.remaining.gt)
          .filter((l) => where.expiresAt?.not !== null || l.expiresAt != null);
        rows.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
        return rows[0] ?? null;
      },
      update: async ({ where, data }: any) => apply(db.lots.find((l) => l.id === where.id)!, data),
    },
    creditTx: {
      create: async ({ data }: any) => {
        const row = { id: `tx${db.txs.length + 1}`, createdAt: NOW, ...data };
        db.txs.push(row);
        return row;
      },
      findMany: async () => [...db.txs],
      findUnique: async ({ where }: any) =>
        db.txs.find((t) => (where.id ? t.id === where.id : t.runId === where.runId)) ?? null,
    },
    creditHold: {
      create: async ({ data }: any) => {
        const row = { createdAt: NOW, ...data };
        db.holds.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => db.holds.find((h) => h.runId === where.runId) ?? null,
      findMany: async ({ where }: any) =>
        db.holds.filter((h) => !where?.expiresAt?.lte || h.expiresAt <= where.expiresAt.lte),
      delete: async ({ where }: any) => {
        const idx = db.holds.findIndex((h) => h.runId === where.runId);
        if (idx >= 0) db.holds.splice(idx, 1);
        return {};
      },
    },
    usageRecord: {
      findUnique: async ({ where }: any) => db.usages.find((u) => u.runId === where.runId) ?? null,
      findMany: async () => [...db.usages],
      create: async ({ data }: any) => {
        const row = { id: `u${db.usages.length + 1}`, createdAt: NOW, credits: null, settledAt: null, ...data };
        db.usages.push(row);
        return row;
      },
      update: async ({ where, data }: any) => apply(db.usages.find((u) => u.runId === where.runId)!, data),
    },
    modelPrice: { findMany: async () => [...db.prices] },
    run: { findUnique: async () => ({ status: 'succeeded' }) },
    $queryRaw: async () => [],
    // 真实 Prisma 事务失败会回滚；内存版用快照模拟，保证 beginRun 校验失败不残留预占。
    $transaction: async (fn: any) => {
      const snapshot = {
        plans: structuredClone(db.plans),
        subs: structuredClone(db.subs),
        lots: structuredClone(db.lots),
        txs: structuredClone(db.txs),
        credits: structuredClone(db.credits),
        holds: structuredClone(db.holds),
        usages: structuredClone(db.usages),
        prices: structuredClone(db.prices),
      };
      try {
        return await fn(client);
      } catch (err) {
        Object.assign(db, snapshot);
        throw err;
      }
    },
  };

  return { db, prisma: client as unknown as PrismaService };
}

const limiter = { hit: async () => ({ allowed: true, retryAfter: 0 }) };

function seed(db: ReturnType<typeof makeDb>['db']) {
  db.plans.push({
    id: 'free',
    name: '体验版',
    priceCents: 0,
    monthlyBaseCredits: 500,
    monthlyBonusCredits: 0,
    maxCreditsPerRun: 50,
    rpm: 10,
    allowedModels: ['mock'],
    active: true,
  });
  db.prices.push({ model: 'mock', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 });
}

let ctx: ReturnType<typeof makeDb>;
let svc: BillingService;

beforeEach(() => {
  ctx = makeDb();
  seed(ctx.db);
  svc = new BillingService(ctx.prisma, limiter as any);
});

describe('BillingService', () => {
  it('首次访问懒建 free 订阅并发放 500 积分', async () => {
    const summary = await svc.summary('t1');
    expect(summary.balance).toBe(500);
    expect(summary.plan.id).toBe('free');
    expect(ctx.db.lots).toHaveLength(1);
    expect(ctx.db.txs[0]).toMatchObject({ type: 'grant', amount: 500, source: 'base' });
  });

  it('beginRun 预占不超过单次上限，余额为 0 时抛 InsufficientCreditsError', async () => {
    await svc.summary('t1');
    const billing = await svc.beginRun('r1', 't1');
    expect(billing.maxCredits).toBe(50);
    expect(ctx.db.credits[0].reserved).toBe(50);

    ctx.db.credits[0].balance = 50; // 剩余 0 可用
    await expect(svc.beginRun('r2', 't1')).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('settle 按用量扣费、写 consume 流水并释放预占；重复调用幂等', async () => {
    await svc.summary('t1');
    await svc.beginRun('r1', 't1');
    await svc.recordUsage(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      { input: 1000, output: 1000, models: [{ model: 'mock', input: 1000, output: 1000 }] },
    );
    await svc.settle('r1');

    // 1000×100 + 1000×300 = 400000 → 0.4 → 1 积分
    expect(ctx.db.credits[0].balance).toBe(499);
    expect(ctx.db.credits[0].reserved).toBe(0);
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.db.usages[0]).toMatchObject({ status: 'settled', credits: 1 });
    expect(ctx.db.txs.filter((t) => t.type === 'consume')).toHaveLength(1);

    await svc.settle('r1');
    expect(ctx.db.credits[0].balance).toBe(499);
  });

  it('releaseHold 归还预占', async () => {
    await svc.summary('t1');
    await svc.beginRun('r1', 't1');
    await svc.releaseHold('r1');
    expect(ctx.db.credits[0].reserved).toBe(0);
    expect(ctx.db.holds).toHaveLength(0);
  });

  it('sweepExpired 清零过期批次并写 expire 流水', async () => {
    await svc.summary('t1');
    ctx.db.lots[0].expiresAt = new Date('2026-10-18T00:00:00Z');
    await svc.sweepExpired(NOW);
    expect(ctx.db.lots[0].remaining).toBe(0);
    expect(ctx.db.credits[0].balance).toBe(0);
    expect(ctx.db.txs.some((t) => t.type === 'expire' && t.amount === -500)).toBe(true);
  });

  it('adjust 支持发放与收回，收回不得使可用余额为负', async () => {
    await svc.summary('t1');
    await svc.adjust('t1', 100, '补偿', null);
    expect(ctx.db.credits[0].balance).toBe(600);
    await svc.adjust('t1', -600, '收回', null);
    expect(ctx.db.credits[0].balance).toBe(0);
    await expect(svc.adjust('t1', -1, '收回', null)).rejects.toThrow('insufficient_balance');
  });

  it('允许模型缺少价格时拒绝预占', async () => {
    await svc.summary('t1');
    ctx.db.plans[0].allowedModels = ['mock', 'unknown'];
    await expect(svc.beginRun('r1', 't1')).rejects.toThrow('model_price_missing:unknown');
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.db.credits[0].reserved).toBe(0);
  });
});
