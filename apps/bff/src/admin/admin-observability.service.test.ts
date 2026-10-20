import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AdminObservabilityService } from './admin-observability.service';
import type { PrismaService } from '../db/prisma.service';
import type { HealthService } from '../observability/health.service';

interface BucketSeed {
  bucketStart: Date;
  metric: string;
  value: number;
  count?: number;
  dimensionType?: string;
  dimensionId?: string;
}

interface ServiceSeed {
  buckets?: BucketSeed[];
  firing?: number;
  p95?: Record<string, number | null>;
}

function makeService(seed: ServiceSeed = {}) {
  const buckets = seed.buckets ?? [];
  const calls: Array<{ where?: any }> = [];

  const prisma = {
    metricBucket: {
      findMany: async (args: { where?: any }) => {
        calls.push(args);
        const where = args.where ?? {};
        return buckets
          .filter((bucket) => {
            if (bucket.bucketStart < where.bucketStart.gte) return false;
            if (bucket.bucketStart >= where.bucketStart.lt) return false;
            if (where.metric?.in && !where.metric.in.includes(bucket.metric)) return false;
            if (where.dimensionType && (bucket.dimensionType ?? 'global') !== where.dimensionType) {
              return false;
            }
            if (where.dimensionId !== undefined && (bucket.dimensionId ?? '') !== where.dimensionId) {
              return false;
            }
            return true;
          })
          .map((bucket) => ({
            bucketStart: bucket.bucketStart,
            metric: bucket.metric,
            value: bucket.value,
            count: bucket.count ?? 0,
            dimensionId: bucket.dimensionId ?? '',
          }));
      },
    },
    alertEvent: {
      count: async () => seed.firing ?? 0,
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const from = values[0] as Date;
      return [{ p95: seed.p95?.[from.toISOString()] ?? null }];
    },
  } as unknown as PrismaService;

  const health = {
    ready: async () => ({
      status: 'ready',
      version: 'test',
      checks: {
        db: { ok: true, latencyMs: 1 },
        redis: { ok: true, skipped: true },
        runtime: { ok: true, latencyMs: 2 },
      },
    }),
  } as unknown as HealthService;

  return { svc: new AdminObservabilityService(prisma, health), calls };
}

const highVolume: BucketSeed[] = [
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'runs_started', value: 3 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'runs_done', value: 2 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'runs_failed', value: 1 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'run_duration_ms', value: 3000, count: 3 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'input_tokens', value: 100 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'output_tokens', value: 50 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'credits', value: 7 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'runs_started', value: 2 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'runs_done', value: 2 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'input_tokens', value: 40 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'output_tokens', value: 20 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'credits', value: 3 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'runs_started', value: 10 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'runs_done', value: 9 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'runs_failed', value: 1 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'credits', value: 20 },
  {
    bucketStart: new Date('2026-10-20T10:00:00Z'),
    metric: 'credits',
    dimensionType: 'model',
    dimensionId: 'model-a',
    value: 6,
  },
  {
    bucketStart: new Date('2026-10-20T10:00:00Z'),
    metric: 'credits',
    dimensionType: 'model',
    dimensionId: 'model-b',
    value: 4,
  },
  {
    bucketStart: new Date('2026-10-18T10:00:00Z'),
    metric: 'credits',
    dimensionType: 'model',
    dimensionId: 'model-a',
    value: 99,
  },
];

const now = new Date('2026-10-20T12:34:00Z');

describe('AdminObservabilityService', () => {
  it('24h 概览汇总当前/上一周期、补零序列、模型成本与健康状态', async () => {
    const { svc } = makeService({
      buckets: highVolume,
      firing: 2,
      p95: {
        '2026-10-19T13:00:00.000Z': 320,
        '2026-10-18T13:00:00.000Z': 410,
      },
    });
    const dto = await svc.overview({ range: '24h' }, now);

    expect(dto.range).toBe('24h');
    expect(dto.current).toEqual({
      runs: 5,
      failedRuns: 1,
      successRate: 0.8,
      inputTokens: 140,
      outputTokens: 70,
      credits: 10,
      avgDurationMs: 1000,
      p95DurationMs: 320,
      unresolvedAlerts: 2,
    });
    expect(dto.previous).toMatchObject({
      runs: 10,
      failedRuns: 1,
      successRate: 0.9,
      credits: 20,
      avgDurationMs: null,
      p95DurationMs: 410,
      unresolvedAlerts: 2,
    });
    expect(dto.series).toHaveLength(24);
    expect(dto.series[0].bucketStart).toBe('2026-10-19T13:00:00.000Z');
    expect(dto.series[21]).toMatchObject({ runs: 3, failedRuns: 1, credits: 7, avgDurationMs: 1000 });
    expect(dto.series[22]).toMatchObject({ runs: 2, failedRuns: 0, credits: 3, avgDurationMs: null });
    expect(dto.series[20]).toMatchObject({ runs: 0, failedRuns: 0, credits: 0 });
    expect(dto.modelCosts).toEqual([
      { model: 'model-a', credits: 6 },
      { model: 'model-b', credits: 4 },
    ]);
    expect(dto.serviceHealth).toEqual([
      { name: 'db', up: true, checkedAt: '2026-10-20T12:34:00.000Z' },
      { name: 'redis', up: true, checkedAt: '2026-10-20T12:34:00.000Z' },
      { name: 'runtime', up: true, checkedAt: '2026-10-20T12:34:00.000Z' },
    ]);
    expect(dto.generatedAt).toBe('2026-10-20T12:34:00.000Z');
  });

  it('7d 按 UTC 天聚合，序列首尾与窗口对齐', async () => {
    const { svc } = makeService({
      buckets: [
        { bucketStart: new Date('2026-10-18T05:00:00Z'), metric: 'runs_started', value: 2 },
        { bucketStart: new Date('2026-10-18T06:00:00Z'), metric: 'runs_started', value: 3 },
      ],
    });
    const dto = await svc.overview({ range: '7d' }, now);
    expect(dto.series).toHaveLength(7);
    expect(dto.series[0].bucketStart).toBe('2026-10-14T00:00:00.000Z');
    expect(dto.series[6].bucketStart).toBe('2026-10-20T00:00:00.000Z');
    expect(dto.series[4]).toMatchObject({ bucketStart: '2026-10-18T00:00:00.000Z', runs: 5 });
  });

  it('非法 range 抛 400', async () => {
    const { svc } = makeService();
    await expect(svc.overview({ range: '1y' }, now)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('timeseries 按天聚合、缺桶补 0 并回显范围', async () => {
    const { svc } = makeService({
      buckets: [
        { bucketStart: new Date('2026-10-18T05:00:00Z'), metric: 'runs_started', value: 2 },
        { bucketStart: new Date('2026-10-19T05:00:00Z'), metric: 'credits', value: 4 },
      ],
    });
    const dto = await svc.timeseries({
      metrics: 'runs_started,credits',
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-20T00:00:00Z',
      granularity: 'day',
    });
    expect(dto).toMatchObject({
      from: '2026-10-18T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
      granularity: 'day',
    });
    expect(dto.series.map((s) => s.metric)).toEqual(['runs_started', 'credits']);
    expect(dto.series[0].points.map((p) => p.value)).toEqual([2, 0]);
    expect(dto.series[1].points.map((p) => p.value)).toEqual([0, 4]);
    expect(dto.series[0].points[0].bucketStart).toBe('2026-10-18T00:00:00.000Z');
  });

  it('timeseries 按维度过滤', async () => {
    const { svc, calls } = makeService();
    await svc.timeseries({
      metrics: 'credits',
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-20T00:00:00Z',
      dimensionType: 'model',
      dimensionId: 'model-a',
    });
    expect(calls[0].where).toMatchObject({
      dimensionType: 'model',
      dimensionId: 'model-a',
      metric: { in: ['credits'] },
    });
  });

  it('timeseries 未指定维度时按维度拆分，尾部合并为 other', async () => {
    const buckets: BucketSeed[] = Array.from({ length: 10 }, (_, index) => ({
      bucketStart: new Date('2026-10-18T05:00:00Z'),
      metric: 'credits',
      dimensionType: 'model',
      dimensionId: `m${index}`,
      value: index + 1,
    }));
    const { svc } = makeService({ buckets });
    const dto = await svc.timeseries({
      metrics: 'credits',
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-19T00:00:00Z',
      granularity: 'day',
      dimensionType: 'model',
    });
    expect(dto.series.map((s) => s.dimensionId)).toEqual([
      'm9',
      'm8',
      'm7',
      'm6',
      'm5',
      'm4',
      'm3',
      'other',
    ]);
    expect(dto.series[7].points[0].value).toBe(1 + 2 + 3);
  });

  it('timeseries 校验 metric 数量、范围与枚举', async () => {
    const { svc } = makeService();
    const base = { from: '2026-10-18T00:00:00Z', to: '2026-10-20T00:00:00Z' };
    await expect(
      svc.timeseries({ ...base, metrics: 'runs,credits,runs_started,runs_done,runs_failed' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.timeseries({ ...base, metrics: 'secret_metric' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.timeseries({
        metrics: 'credits',
        from: '2026-01-01T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.timeseries({ metrics: 'credits', from: base.to, to: base.from }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.timeseries({ ...base, metrics: 'credits', granularity: 'minute' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.timeseries({ ...base, metrics: 'credits', dimensionType: 'user' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
