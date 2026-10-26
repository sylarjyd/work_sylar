import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BillingService } from './billing.service';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from './billing.errors';
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
    runs: [] as Row[],
    tasks: [] as Row[],
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
      // 用 vi.fn 包一层，便于断言准入路径未触碰额度。
      update: vi.fn(async ({ where, data }: any) =>
        apply(db.credits.find((c) => c.tenantId === where.tenantId)!, data),
      ),
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
      findFirst: async ({ where }: any) =>
        db.txs.find((t) => t.id === where.id && t.tenantId === where.tenantId) ?? null,
    },
    creditHold: {
      create: vi.fn(async ({ data }: any) => {
        const row = { createdAt: NOW, ...data };
        db.holds.push(row);
        return row;
      }),
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
      findMany: async ({ where = {}, orderBy, take }: any = {}) => {
        let rows = db.usages.filter((u) => {
          if (where.runId?.gt !== undefined && !(u.runId > where.runId.gt)) return false;
          if (where.tenantId !== undefined && u.tenantId !== where.tenantId) return false;
          if (where.status !== undefined && u.status !== where.status) return false;
          if (where.createdAt?.lt && !(u.createdAt < where.createdAt.lt)) return false;
          if (where.createdAt?.lte && !(u.createdAt <= where.createdAt.lte)) return false;
          if (where.createdAt?.gte && !(u.createdAt >= where.createdAt.gte)) return false;
          return true;
        });
        const clauses = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
        for (const clause of [...clauses].reverse()) {
          for (const [key, dir] of Object.entries(clause)) {
            rows = [...rows].sort((a, b) => {
              const av = a[key] instanceof Date ? a[key].getTime() : a[key];
              const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
              if (av === bv) return 0;
              return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
            });
          }
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return rows;
      },
      create: async ({ data }: any) => {
        if (db.usages.some((u) => u.runId === data.runId)) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `u${db.usages.length + 1}`, createdAt: NOW, credits: null, settledAt: null, ...data };
        db.usages.push(row);
        return row;
      },
      update: async ({ where, data }: any) => apply(db.usages.find((u) => u.runId === where.runId)!, data),
      updateMany: async ({ where, data }: any) => {
        const targets = db.usages.filter(
          (u) => u.runId === where.runId && (!where.status || u.status === where.status),
        );
        targets.forEach((u) => apply(u, data));
        return { count: targets.length };
      },
    },
    modelConfig: { findMany: async () => [...db.prices] },
    run: {
      findUnique: async ({ where }: any) => {
        const row = db.runs.find((r) => r.id === where.id);
        return row ? { status: row.status, taskId: row.taskId } : null;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = db.runs.filter(
          (r) => r.id === where.id && (!where.status || r.status === where.status),
        );
        targets.forEach((r) => apply(r, data));
        return { count: targets.length };
      },
    },
    task: {
      updateMany: async ({ where, data }: any) => {
        const targets = db.tasks.filter(
          (t) => t.id === where.id && (!where.status || t.status === where.status),
        );
        targets.forEach((t) => apply(t, data));
        return { count: targets.length };
      },
    },
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
        runs: structuredClone(db.runs),
        tasks: structuredClone(db.tasks),
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

// 默认放行；单个用例可通过 makeService({ rateLimited: true }) 切到超限分支。
let rateLimited = false;
const limiter = {
  hit: vi.fn(async () => (rateLimited ? { allowed: false, retryAfter: 7 } : { allowed: true, retryAfter: 0 })),
};

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

/** 统一构造服务；rateLimited 仅覆盖限流结果，既有用例不传即保持放行。 */
function makeService(opts: { rateLimited?: boolean } = {}): BillingService {
  ctx = makeDb();
  seed(ctx.db);
  rateLimited = opts.rateLimited ?? false;
  limiter.hit.mockClear();
  return new BillingService(ctx.prisma, limiter as any);
}

beforeEach(() => {
  svc = makeService();
});

describe('BillingService', () => {
  it('首次访问懒建 free 订阅并发放 500 积分', async () => {
    const summary = await svc.summary('t1');
    expect(summary.balance).toBe(500);
    expect(summary.plan.id).toBe('free');
    expect(ctx.db.lots).toHaveLength(1);
    expect(ctx.db.txs[0]).toMatchObject({ type: 'grant', amount: 500, source: 'base' });
  });

  it('admitRun 只校验不预占', async () => {
    const admitted = makeService();
    await admitted.admitRun('t1');
    expect(ctx.prisma.creditHold.create).not.toHaveBeenCalled();
    expect(ctx.prisma.tenantCredit.update).not.toHaveBeenCalled();
  });

  it('admitRun 命中限流抛 RateLimitedError', async () => {
    const admitted = makeService({ rateLimited: true });
    await expect(admitted.admitRun('t1')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('admitRun 可用余额不足时抛 InsufficientCreditsError 且不预占', async () => {
    const admitted = makeService();
    // 先懒建订阅拿到 500 积分，再把额度全部占满，构造 balance-reserved = 0。
    await admitted.summary('t1');
    ctx.db.credits[0].balance = 100;
    ctx.db.credits[0].reserved = 100;

    await expect(admitted.admitRun('t1')).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.prisma.creditHold.create).not.toHaveBeenCalled();
    expect(ctx.prisma.tenantCredit.update).not.toHaveBeenCalled();
  });

  it('admitRun 套餐过期抛 PlanExpiredError', async () => {
    const admitted = makeService();
    ctx.db.plans.push({
      id: 'pro',
      name: '专业版',
      priceCents: 990,
      monthlyBaseCredits: 10000,
      monthlyBonusCredits: 0,
      maxCreditsPerRun: 200,
      rpm: 60,
      allowedModels: ['mock'],
      active: true,
    });
    // 付费套餐已过 periodEnd：ensureSubscription 将其标记 expired 后由准入拒绝。
    ctx.db.subs.push({
      id: 'sub1',
      tenantId: 't1',
      planId: 'pro',
      status: 'active',
      periodStart: new Date('2026-09-01T00:00:00Z'),
      periodEnd: new Date('2026-09-30T00:00:00Z'),
    });

    await expect(admitted.admitRun('t1')).rejects.toBeInstanceOf(PlanExpiredError);
    expect(ctx.db.holds).toHaveLength(0);
  });

  it('admitRun 允许模型缺价格时拒绝', async () => {
    const admitted = makeService();
    ctx.db.plans[0].allowedModels = ['mock', 'unknown'];

    await expect(admitted.admitRun('t1')).rejects.toThrow('model_price_missing:unknown');
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.prisma.creditHold.create).not.toHaveBeenCalled();
    expect(ctx.prisma.tenantCredit.update).not.toHaveBeenCalled();
  });

  it('beginRun 不再消耗 RPM', async () => {
    const admitted = makeService();
    await admitted.beginRun('r1', 't1');
    expect(limiter.hit).not.toHaveBeenCalled();
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

  it('settle 之后 recordUsage 不得把已结算记录改回 pending', async () => {
    await svc.summary('t1');
    await svc.beginRun('r1', 't1');
    const meta = { tenantId: 't1', userId: 'u1', sessionId: 's1' };
    await svc.recordUsage('r1', meta, {
      input: 1000,
      output: 1000,
      models: [{ model: 'mock', input: 1000, output: 1000 }],
    });
    await svc.settle('r1');
    const balance = ctx.db.credits[0].balance;

    await svc.recordUsage('r1', meta, {
      input: 9000,
      output: 9000,
      models: [{ model: 'mock', input: 9000, output: 9000 }],
    });

    expect(ctx.db.usages[0]).toMatchObject({
      status: 'settled',
      credits: 1,
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(ctx.db.credits[0].balance).toBe(balance);
  });

  it('无 hold 结算最多扣到可用余额，不吃掉其他运行的预占', async () => {    await svc.summary('t1');
    // r2 先预占 50，余额 500 中可用只剩 450。
    const billing = await svc.beginRun('r2', 't1');
    expect(billing.maxCredits).toBe(50);
    expect(ctx.db.credits[0].reserved).toBe(50);

    // r1 没有 hold（异常/超时兜底路径），用量远超余额。
    await svc.recordUsage(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      {
        input: 10_000_000,
        output: 10_000_000,
        models: [{ model: 'mock', input: 10_000_000, output: 10_000_000 }],
      },
    );
    await svc.settle('r1');

    const credit = ctx.db.credits[0];
    const usage = ctx.db.usages.find((u) => u.runId === 'r1')!;
    const consumed = ctx.db.txs.filter((t) => t.type === 'consume');
    expect(usage).toMatchObject({ status: 'settled', credits: 450 });
    expect(consumed).toHaveLength(1);
    expect(consumed[0].amount).toBe(-450);
    expect(credit.balance).toBe(50);
    expect(credit.reserved).toBe(50);
    expect(credit.balance).toBeGreaterThanOrEqual(0);
    // 不变量：实扣 + 仍预占不超过结算前余额（等价于结算后余额 >= 预占）。
    expect(usage.credits + credit.reserved).toBeLessThanOrEqual(credit.balance + 450);
    expect(credit.reserved).toBeLessThanOrEqual(credit.balance);
    // r2 的预占仍然存在。
    expect(ctx.db.holds).toHaveLength(1);
  });

  it('无 hold 且可用余额为 0 时不扣费但标记结算', async () => {
    await svc.summary('t1');
    // 单次上限拉到 500，让 r2 把余额全部预占，r1 可用额度为 0。
    ctx.db.plans[0].maxCreditsPerRun = 500;
    await svc.beginRun('r2', 't1');
    expect(ctx.db.credits[0].reserved).toBe(500);

    // r1 没有 hold，且此刻没有任何可用余额。
    await svc.recordUsage(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      { input: 1000, output: 1000, models: [{ model: 'mock', input: 1000, output: 1000 }] },
    );
    await svc.settle('r1');

    const credit = ctx.db.credits[0];
    const usage = ctx.db.usages.find((u) => u.runId === 'r1')!;
    expect(usage).toMatchObject({ status: 'settled', credits: 0 });
    // 没有实扣就不写 r1 的 consume 流水，余额与预占保持不变。
    expect(ctx.db.txs.filter((t) => t.type === 'consume' && t.runId === 'r1')).toHaveLength(0);
    expect(credit.balance).toBe(500);
    expect(credit.reserved).toBe(500);
    expect(credit.reserved).toBeLessThanOrEqual(credit.balance);
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

  it('过期预占对应的 run 仍 running 时标记 failed 并释放', async () => {
    await svc.summary('t1');
    await svc.beginRun('r1', 't1');
    ctx.db.runs.push({ id: 'r1', taskId: 'task1', status: 'running', endedAt: null });
    ctx.db.tasks.push({ id: 'task1', status: 'running' });
    ctx.db.holds[0].expiresAt = new Date('2026-10-18T00:00:00Z');

    await svc.sweepOrphanHolds(NOW);

    // 进程崩溃后 run/task 永远停在 running，补偿要在释放预占前收尾。
    expect(ctx.db.runs[0]).toMatchObject({ status: 'failed', endedAt: NOW });
    expect(ctx.db.tasks[0].status).toBe('failed');
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.db.credits[0].reserved).toBe(0);
  });

  it('adjust 支持发放与收回，收回不得使可用余额为负', async () => {
    await svc.summary('t1');
    await expect(svc.adjust('t1', 0, '零调整', null)).rejects.toThrow('amount_required');
    await svc.adjust('t1', 100, '补偿', null);
    expect(ctx.db.credits[0].balance).toBe(600);
    await svc.adjust('t1', -600, '收回', null);
    expect(ctx.db.credits[0].balance).toBe(0);
    await expect(svc.adjust('t1', -1, '收回', null)).rejects.toThrow('insufficient_balance');
  });

  it('adjust 正数累计超出 Int 上限时拒绝', async () => {
    await svc.summary('t1');
    ctx.db.credits[0].balance = 2_147_483_647;
    const lotsBefore = ctx.db.lots.length;
    const txsBefore = ctx.db.txs.length;

    await expect(svc.adjust('t1', 1, '溢出', null)).rejects.toThrow('amount_too_large');
    expect(ctx.db.lots).toHaveLength(lotsBefore);
    expect(ctx.db.txs).toHaveLength(txsBefore);
    expect(ctx.db.credits[0].balance).toBe(2_147_483_647);
  });

  it('管理员开通套餐时月末日期夹到目标月最后一天', async () => {
    ctx.db.plans.push({
      id: 'pro',
      name: '专业版',
      priceCents: 990,
      monthlyBaseCredits: 10000,
      monthlyBonusCredits: 0,
      maxCreditsPerRun: 200,
      rpm: 60,
      allowedModels: ['mock'],
      active: true,
    });
    const year = new Date().getUTCFullYear() + 1;
    const summary = await svc.adminSubscribe('t1', 'pro', new Date(Date.UTC(year, 0, 31, 8)));
    const lastFeb = new Date(Date.UTC(year, 2, 0)).getUTCDate();
    expect(summary.plan.id).toBe('pro');
    expect(summary.subscription.periodEnd).toBe(new Date(Date.UTC(year, 1, lastFeb)).toISOString());
  });

  it('settleStalePending 单条失败不阻断后续', async () => {
    await svc.summary('t1');
    const stale = new Date('2026-10-18T00:00:00Z');
    ctx.db.usages.push(
      {
        id: 'u1',
        runId: 'bad1',
        tenantId: 't1',
        userId: 'u1',
        sessionId: 's1',
        models: [{ model: 'mock', input: 1000, output: 0 }],
        inputTokens: 1000,
        outputTokens: 0,
        status: 'pending',
        credits: null,
        settledAt: null,
        createdAt: stale,
      },
      {
        id: 'u2',
        runId: 'good1',
        tenantId: 't1',
        userId: 'u1',
        sessionId: 's1',
        models: [{ model: 'mock', input: 1000, output: 0 }],
        inputTokens: 1000,
        outputTokens: 0,
        status: 'pending',
        credits: null,
        settledAt: null,
        createdAt: stale,
      },
    );
    const original = svc.settle.bind(svc);
    const calls: string[] = [];
    vi.spyOn(svc, 'settle').mockImplementation(async (runId: string) => {
      calls.push(runId);
      if (runId === 'bad1') throw new Error('boom');
      return original(runId);
    });

    await svc.settleStalePending(NOW);

    expect(calls).toEqual(['bad1', 'good1']);
    expect(ctx.db.usages.find((u) => u.runId === 'bad1')!.status).toBe('pending');
    expect(ctx.db.usages.find((u) => u.runId === 'good1')!.status).toBe('settled');
  });

  it('允许模型缺少价格时拒绝预占', async () => {
    await svc.summary('t1');
    ctx.db.plans[0].allowedModels = ['mock', 'unknown'];
    await expect(svc.beginRun('r1', 't1')).rejects.toThrow('model_price_missing:unknown');
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.db.credits[0].reserved).toBe(0);
  });
});
