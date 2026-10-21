import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsSweeper } from './metrics.sweeper';
import type { PrismaService } from '../db/prisma.service';
import type { LeaderLock } from './leader-lock';
import { createBffMetrics } from '../observability/observability.metrics';

const NOW = new Date('2026-10-20T10:35:00.000Z');

interface SeedRun {
  id: string;
  tenantId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

function makePrisma(runs: SeedRun[] = []) {
  const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const deletes: Array<{ where: Record<string, unknown> }> = [];
  const alertDeletes: Array<{ where: Record<string, unknown> }> = [];
  let runQueries = 0;

  const view = (r: SeedRun) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    task: { session: { tenantId: r.tenantId } },
  });

  const db = {
    run: {
      findMany: async ({ where }: any) => {
        runQueries += 1;
        if (where.startedAt) {
          return runs
            .filter(
              (r) => r.startedAt >= where.startedAt.gte && r.startedAt < where.startedAt.lt,
            )
            .map(view);
        }
        return runs
          .filter(
            (r) =>
              r.endedAt !== null &&
              r.endedAt >= where.endedAt.gte &&
              r.endedAt < where.endedAt.lt &&
              where.status.in.includes(r.status),
          )
          .map(view);
      },
    },
    usageRecord: { findMany: async () => [] },
    step: { findMany: async () => [] },
    modelConfig: { findMany: async () => [] },
    metricBucket: {
      upsert: async (args: any) => {
        upserts.push(args);
        return {};
      },
      findMany: async () => [],
      deleteMany: async (args: any) => {
        deletes.push(args);
        return { count: 0 };
      },
    },
    alertEvent: {
      findMany: async () => [],
      deleteMany: async (args: any) => {
        alertDeletes.push(args);
        return { count: 0 };
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };

  return {
    prisma: db as unknown as PrismaService,
    upserts,
    deletes,
    alertDeletes,
    runQueries: () => runQueries,
  };
}

const lock = (acquired = true): LeaderLock => ({ acquire: async () => acquired });

beforeEach(() => {
  // 固定补算 2 小时，断言不依赖默认的 24 小时。
  process.env.METRICS_BACKFILL_HOURS = '2';
});

afterEach(() => {
  delete process.env.METRICS_BACKFILL_HOURS;
  delete process.env.METRICS_RETENTION_DAYS;
  delete process.env.ALERT_RETENTION_DAYS;
  delete process.env.METRICS_ROLLUP_MS;
  vi.useRealTimers();
});

describe('MetricsSweeper', () => {
  it('重算当前小时之前的两个完整小时并 upsert', async () => {
    const runs: SeedRun[] = [
      {
        id: 'r1',
        tenantId: 't1',
        status: 'done',
        startedAt: new Date('2026-10-20T08:10:00Z'),
        endedAt: new Date('2026-10-20T08:11:00Z'),
      },
      {
        id: 'r2',
        tenantId: 't2',
        status: 'failed',
        startedAt: new Date('2026-10-20T09:10:00Z'),
        endedAt: new Date('2026-10-20T09:12:00Z'),
      },
    ];
    const { prisma, upserts } = makePrisma(runs);
    const sweeper = new MetricsSweeper(prisma, lock());

    await sweeper.tick(NOW);

    const keys = upserts.map(
      (u) =>
        `${String((u.create as any).bucketStart.toISOString())}|${String((u.create as any).metric)}|${String((u.create as any).dimensionType)}|${String((u.create as any).dimensionId)}`,
    );
    expect(keys).toContain('2026-10-20T08:00:00.000Z|runs_started|global|');
    expect(keys).toContain('2026-10-20T08:00:00.000Z|runs_done|tenant|t1');
    expect(keys).toContain('2026-10-20T09:00:00.000Z|runs_failed|global|');
    // 当前小时（10:00）尚未完整，不能入库。
    expect(keys.some((k) => k.startsWith('2026-10-20T10:00:00.000Z'))).toBe(false);
  });

  it('未抢到锁时完全不查库', async () => {
    const { prisma, upserts, runQueries } = makePrisma();
    const sweeper = new MetricsSweeper(prisma, lock(false));
    await sweeper.tick(NOW);
    expect(runQueries()).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it('单轮失败只记指标与日志，不向外抛', async () => {
    const metrics = createBffMetrics({ defaultMetrics: false });
    const broken = {
      run: {
        findMany: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaService;
    const sweeper = new MetricsSweeper(broken, lock(), metrics);

    await expect(sweeper.tick(NOW)).resolves.toBeUndefined();
    expect(await metrics.registry.metrics()).toContain('ai_office_rollup_failures_total 1');
  });

  it('按各自保留天数分 5000 行一批清理过期快照与告警事件', async () => {
    process.env.METRICS_RETENTION_DAYS = '2';
    process.env.ALERT_RETENTION_DAYS = '3';
    const { prisma, deletes, alertDeletes } = makePrisma();
    let bucketBatch = 0;
    let alertBatch = 0;
    (prisma.metricBucket as any).findMany = async () => {
      bucketBatch += 1;
      return bucketBatch === 1
        ? Array.from({ length: 5000 }, (_, i) => ({ id: `b${i}` }))
        : [];
    };
    (prisma.alertEvent as any).findMany = async () => {
      alertBatch += 1;
      return alertBatch === 1
        ? Array.from({ length: 5000 }, (_, i) => ({ id: `e${i}` }))
        : [];
    };
    const sweeper = new MetricsSweeper(prisma, lock());

    await sweeper.purgeRetention(NOW);

    expect(bucketBatch).toBe(2);
    expect(deletes).toHaveLength(1);
    expect((deletes[0].where as any).id.in).toHaveLength(5000);
    expect(((deletes[0].where as any).bucketStart.lt as Date).toISOString()).toBe(
      '2026-10-18T10:35:00.000Z',
    );
    expect(alertBatch).toBe(2);
    expect(alertDeletes).toHaveLength(1);
    expect((alertDeletes[0].where as any).id.in).toHaveLength(5000);
    expect(((alertDeletes[0].where as any).startedAt.lt as Date).toISOString()).toBe(
      '2026-10-17T10:35:00.000Z',
    );
  });

  it('METRICS_ROLLUP_MS=0 时关闭定时任务', () => {
    vi.useFakeTimers();
    process.env.METRICS_ROLLUP_MS = '0';
    const { prisma } = makePrisma();
    const sweeper = new MetricsSweeper(prisma, lock());
    const tick = vi.spyOn(sweeper, 'tick');

    sweeper.onModuleInit();
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(tick).not.toHaveBeenCalled();
    sweeper.onModuleDestroy();
  });
});
