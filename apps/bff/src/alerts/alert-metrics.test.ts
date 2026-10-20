import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AlertMetricReader } from './alert-metrics';
import type { PrismaService } from '../db/prisma.service';
import type { HealthService } from '../observability/health.service';
import type { RuntimeSummaryProvider } from './runtime-summary.client';

const NOW = new Date('2026-10-20T10:00:00.000Z');

function makeReader(overrides: Record<string, unknown> = {}) {
  const db = {
    run: { groupBy: vi.fn(async () => []) },
    usageRecord: { count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { credits: null } })) },
    $queryRaw: vi.fn(async () => []),
    ...overrides,
  } as unknown as PrismaService;
  const health = { ready: vi.fn(async () => ({ status: 'ready' })) } as unknown as HealthService;
  const runtime: RuntimeSummaryProvider = { fetch: vi.fn(async () => null) };
  return { reader: new AlertMetricReader(db, health, runtime), db, health, runtime };
}

describe('AlertMetricReader', () => {
  it('运行失败率只统计终态 run，无样本返回 null', async () => {
    const { reader, db } = makeReader({
      run: {
        groupBy: vi.fn(async () => [
          { status: 'done', _count: { _all: 3 } },
          { status: 'failed', _count: { _all: 1 } },
        ]),
      },
    });
    await expect(reader.read('run_failure_rate', 15, NOW)).resolves.toBeCloseTo(0.25);
    expect((db.run.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      status: { in: ['done', 'failed'] },
    });

    const empty = makeReader();
    await expect(empty.reader.read('run_failure_rate', 15, NOW)).resolves.toBeNull();
  });

  it('P95 用 percentile_cont，窗口内无样本为 null', async () => {
    const { reader } = makeReader({ $queryRaw: async () => [{ p95: 4321.5 }] });
    await expect(reader.read('run_latency_p95_ms', 15, NOW)).resolves.toBe(4321.5);

    const empty = makeReader({ $queryRaw: async () => [{ p95: null }] });
    await expect(empty.reader.read('run_latency_p95_ms', 15, NOW)).resolves.toBeNull();
  });

  it('结算滞留只统计 5 分钟前的 pending', async () => {
    const { reader, db } = makeReader({
      usageRecord: {
        count: vi.fn(async () => 2),
        aggregate: vi.fn(async () => ({ _sum: { credits: null } })),
      },
    });
    await expect(reader.read('billing_settle_failures', 15, NOW)).resolves.toBe(2);
    const where = (db.usageRecord.count as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.status).toBe('pending');
    expect(where.createdAt.lt.toISOString()).toBe('2026-10-20T09:55:00.000Z');
  });

  it('积分总量取已结算记录之和，缺省为 0', async () => {
    const { reader } = makeReader({
      usageRecord: {
        count: async () => 0,
        aggregate: async () => ({ _sum: { credits: 120 } }),
      },
    });
    await expect(reader.read('credits_per_window', 60, NOW)).resolves.toBe(120);

    const empty = makeReader();
    await expect(empty.reader.read('credits_per_window', 60, NOW)).resolves.toBe(0);
  });

  it('模型错误率按请求量加权，数据不足为 null', async () => {
    const { reader, runtime } = makeReader();
    (runtime.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok',
      windowMinutes: 15,
      activeRuns: 0,
      models: [
        { model: 'a', requests: 9, errors: 3, avgLatencyMs: 10 },
        { model: 'b', requests: 1, errors: 0, avgLatencyMs: 10 },
      ],
      fallbacks: 0,
      mcpRestarts: 0,
    });
    await expect(reader.read('model_error_rate', 15, NOW)).resolves.toBeCloseTo(0.3);

    (runtime.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'insufficient_data',
      windowMinutes: 15,
      activeRuns: 0,
      models: [],
      fallbacks: 0,
      mcpRestarts: 0,
    });
    await expect(reader.read('model_error_rate', 15, NOW)).resolves.toBeNull();
  });

  it('服务健康全部通过才算 1，未知指标返回 null', async () => {
    const { reader, health, db } = makeReader();
    await expect(reader.read('service_up', 2, NOW)).resolves.toBe(1);

    (health.ready as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'degraded' });
    await expect(reader.read('service_up', 2, NOW)).resolves.toBe(0);

    await expect(reader.read('not_a_metric', 2, NOW)).resolves.toBeNull();
    expect((db.run.groupBy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
