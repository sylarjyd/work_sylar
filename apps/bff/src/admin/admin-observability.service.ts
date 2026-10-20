import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AdminMetricDimensionType,
  AdminMetricGranularity,
  AdminMetricPointDto,
  AdminMetricSeriesDto,
  AdminMetricTimeseriesDto,
  AdminOverviewDto,
  AdminOverviewKpiDto,
  AdminOverviewPointDto,
  AdminOverviewRange,
  AdminServiceHealthDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { HealthService } from '../observability/health.service';
import { optionalDate, optionalString } from './admin.util';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_RANGE_MS = 90 * DAY_MS;
const MAX_TIMESERIES_METRICS = 4;
const MAX_TIMESERIES_DIMENSIONS = 8;
const MAX_MODEL_COSTS = 20;

const RANGE_HOURS: Record<AdminOverviewRange, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const OVERVIEW_METRICS = [
  'runs_started',
  'runs_done',
  'runs_failed',
  'run_duration_ms',
  'input_tokens',
  'output_tokens',
  'credits',
] as const;

const TIMESERIES_METRICS = new Set<string>([
  ...OVERVIEW_METRICS,
  'tool_calls',
  'tool_failures',
]);

const DIMENSION_TYPES: AdminMetricDimensionType[] = ['global', 'model', 'tenant', 'tool'];

interface BucketValue {
  value: number;
  count: number;
}

type BucketMap = Map<number, Map<string, BucketValue>>;

function parseRange(raw: unknown): AdminOverviewRange {
  if (raw === undefined || raw === null || raw === '') return '24h';
  if (raw === '24h' || raw === '7d' || raw === '30d') return raw;
  throw new BadRequestException('invalid_range');
}

function startOfHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function startOfUtcDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function bucketStartOf(date: Date, granularity: AdminMetricGranularity): Date {
  return granularity === 'hour' ? startOfHour(date) : startOfUtcDay(date);
}

function bucketStepMs(granularity: AdminMetricGranularity): number {
  return granularity === 'hour' ? HOUR_MS : DAY_MS;
}

function parseGranularity(raw: unknown): AdminMetricGranularity {
  if (raw === undefined || raw === null || raw === '') return 'hour';
  if (raw === 'hour' || raw === 'day') return raw;
  throw new BadRequestException('invalid_granularity');
}

function parseDimensionType(raw: unknown): AdminMetricDimensionType {
  if (raw === undefined || raw === null || raw === '') return 'global';
  if (typeof raw === 'string' && (DIMENSION_TYPES as string[]).includes(raw)) {
    return raw as AdminMetricDimensionType;
  }
  throw new BadRequestException('invalid_dimension_type');
}

function parseMetrics(raw: unknown): string[] {
  const value = optionalString(raw);
  if (!value) throw new BadRequestException('invalid_metrics');
  const metrics = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (metrics.length === 0 || metrics.length > MAX_TIMESERIES_METRICS) {
    throw new BadRequestException('invalid_metrics');
  }
  if (metrics.some((metric) => !TIMESERIES_METRICS.has(metric))) {
    throw new BadRequestException('invalid_metrics');
  }
  return metrics;
}

@Injectable()
export class AdminObservabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
  ) {}

  async overview(query: Record<string, unknown>, now = new Date()): Promise<AdminOverviewDto> {
    const range = parseRange(query.range);
    const hours = RANGE_HOURS[range];
    const stepMs = range === '24h' ? HOUR_MS : DAY_MS;
    const currentStart = range === '24h' ? startOfHour(now) : startOfUtcDay(now);
    const end = new Date(currentStart.getTime() + stepMs);
    const start = new Date(end.getTime() - hours * HOUR_MS);
    const previousStart = new Date(start.getTime() - hours * HOUR_MS);

    const [currentBuckets, previousBuckets, currentP95, previousP95, unresolvedAlerts] =
      await Promise.all([
        this.readBuckets(start, end),
        this.readBuckets(previousStart, start),
        this.p95(start, end),
        this.p95(previousStart, start),
        this.prisma.alertEvent.count({ where: { status: 'firing' } }),
      ]);

    const [modelCosts, serviceHealth] = await Promise.all([
      this.modelCosts(start, end),
      this.serviceHealth(now),
    ]);

    return {
      range,
      current: this.kpi(currentBuckets, start, end, currentP95, unresolvedAlerts),
      previous: this.kpi(previousBuckets, previousStart, start, previousP95, unresolvedAlerts),
      series: this.buildSeries(currentBuckets, start, end, stepMs),
      modelCosts,
      serviceHealth,
      generatedAt: now.toISOString(),
    };
  }

  async timeseries(query: Record<string, unknown>): Promise<AdminMetricTimeseriesDto> {
    const metrics = parseMetrics(query.metrics);
    const from = optionalDate(query.from, 'invalid_range');
    const to = optionalDate(query.to, 'invalid_range');
    if (!from || !to || from.getTime() >= to.getTime()) {
      throw new BadRequestException('invalid_range');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('range_too_large');
    }
    const granularity = parseGranularity(query.granularity);
    const dimensionType = parseDimensionType(query.dimensionType);
    const dimensionId = optionalString(query.dimensionId) ?? '';

    const stepMs = bucketStepMs(granularity);
    const first = bucketStartOf(from, granularity);
    const end = this.seriesEnd(to, granularity);

    const rows = await this.prisma.metricBucket.findMany({
      where: {
        metric: { in: metrics },
        dimensionType,
        ...(dimensionId ? { dimensionId } : {}),
        bucketStart: { gte: first, lt: end },
      },
      select: { bucketStart: true, metric: true, dimensionId: true, value: true, count: true },
    });

    // 未指定具体维度时按维度拆分（供按模型堆叠）；维度过多时尾部合并到 other。
    const dimensions = this.seriesDimensions(rows, dimensionType, dimensionId);
    const kept = new Set(dimensions);
    const dimensionOf = (id: string) => (kept.has(id) ? id : 'other');

    const values = new Map<string, BucketValue>();
    for (const row of rows) {
      const key = `${dimensionOf(row.dimensionId)}:${row.bucketStart.getTime()}:${row.metric}`;
      const previous = values.get(key) ?? { value: 0, count: 0 };
      values.set(key, {
        value: previous.value + row.value,
        count: previous.count + row.count,
      });
    }

    const series: AdminMetricSeriesDto[] = [];
    for (const metric of metrics) {
      for (const dim of dimensions) {
        const points: AdminMetricPointDto[] = [];
        for (let t = first.getTime(); t < end.getTime(); t += stepMs) {
          let value = 0;
          let count = 0;
          const bucketEnd = Math.min(t + stepMs, end.getTime());
          for (let h = t; h < bucketEnd; h += HOUR_MS) {
            const bucket = values.get(`${dim}:${h}:${metric}`);
            if (bucket) {
              value += bucket.value;
              count += bucket.count;
            }
          }
          points.push({ bucketStart: new Date(t).toISOString(), value, count });
        }
        series.push({ metric, dimensionType, dimensionId: dim, points });
      }
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      series,
    };
  }

  /**
   * 请求了具体维度就只返回它；否则按总价值降序取前 8 个，尾部归入 other，
   * 既支持按模型堆叠，也避免租户维度把响应撑爆。global 固定单序列。
   */
  private seriesDimensions(
    rows: Array<{ dimensionId: string; value: number }>,
    dimensionType: AdminMetricDimensionType,
    requested: string,
  ): string[] {
    if (dimensionType === 'global') return [''];
    if (requested) return [requested];
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.dimensionId, (totals.get(row.dimensionId) ?? 0) + row.value);
    }
    const ids = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    if (ids.length <= MAX_TIMESERIES_DIMENSIONS) return ids;
    return [...ids.slice(0, MAX_TIMESERIES_DIMENSIONS - 1), 'other'];
  }

  /** 对齐到桶边界；to 恰好落在边界时按右开区间处理，避免多出一个整桶。 */
  private seriesEnd(to: Date, granularity: AdminMetricGranularity): Date {
    const aligned = bucketStartOf(to, granularity);
    return aligned.getTime() === to.getTime()
      ? aligned
      : new Date(aligned.getTime() + bucketStepMs(granularity));
  }

  private async readBuckets(from: Date, to: Date): Promise<BucketMap> {
    const rows = await this.prisma.metricBucket.findMany({
      where: {
        dimensionType: 'global',
        dimensionId: '',
        metric: { in: [...OVERVIEW_METRICS] },
        bucketStart: { gte: from, lt: to },
      },
      select: { bucketStart: true, metric: true, value: true, count: true },
    });

    const map: BucketMap = new Map();
    for (const row of rows) {
      const key = row.bucketStart.getTime();
      let metrics = map.get(key);
      if (!metrics) {
        metrics = new Map();
        map.set(key, metrics);
      }
      const previous = metrics.get(row.metric) ?? { value: 0, count: 0 };
      metrics.set(row.metric, {
        value: previous.value + row.value,
        count: previous.count + row.count,
      });
    }
    return map;
  }

  private sumWindow(
    buckets: BucketMap,
    metric: string,
    from: Date,
    to: Date,
    field: 'value' | 'count',
  ): number {
    let total = 0;
    for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
      total += buckets.get(t)?.get(metric)?.[field] ?? 0;
    }
    return total;
  }

  private kpi(
    buckets: BucketMap,
    from: Date,
    to: Date,
    p95: number | null,
    unresolvedAlerts: number,
  ): AdminOverviewKpiDto {
    const done = this.sumWindow(buckets, 'runs_done', from, to, 'value');
    const failed = this.sumWindow(buckets, 'runs_failed', from, to, 'value');
    const durationValue = this.sumWindow(buckets, 'run_duration_ms', from, to, 'value');
    const durationCount = this.sumWindow(buckets, 'run_duration_ms', from, to, 'count');
    return {
      runs: this.sumWindow(buckets, 'runs_started', from, to, 'value'),
      failedRuns: failed,
      successRate: done + failed === 0 ? null : done / (done + failed),
      inputTokens: this.sumWindow(buckets, 'input_tokens', from, to, 'value'),
      outputTokens: this.sumWindow(buckets, 'output_tokens', from, to, 'value'),
      credits: this.sumWindow(buckets, 'credits', from, to, 'value'),
      avgDurationMs: durationCount === 0 ? null : Math.round(durationValue / durationCount),
      p95DurationMs: p95,
      unresolvedAlerts,
    };
  }

  private buildSeries(
    buckets: BucketMap,
    start: Date,
    end: Date,
    stepMs: number,
  ): AdminOverviewPointDto[] {
    const points: AdminOverviewPointDto[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
      const bucketStart = new Date(t);
      const bucketEnd = new Date(Math.min(t + stepMs, end.getTime()));
      const durationValue = this.sumWindow(buckets, 'run_duration_ms', bucketStart, bucketEnd, 'value');
      const durationCount = this.sumWindow(buckets, 'run_duration_ms', bucketStart, bucketEnd, 'count');
      points.push({
        bucketStart: bucketStart.toISOString(),
        runs: this.sumWindow(buckets, 'runs_started', bucketStart, bucketEnd, 'value'),
        failedRuns: this.sumWindow(buckets, 'runs_failed', bucketStart, bucketEnd, 'value'),
        inputTokens: this.sumWindow(buckets, 'input_tokens', bucketStart, bucketEnd, 'value'),
        outputTokens: this.sumWindow(buckets, 'output_tokens', bucketStart, bucketEnd, 'value'),
        credits: this.sumWindow(buckets, 'credits', bucketStart, bucketEnd, 'value'),
        avgDurationMs: durationCount === 0 ? null : Math.round(durationValue / durationCount),
      });
    }
    return points;
  }

  private async modelCosts(
    from: Date,
    to: Date,
  ): Promise<Array<{ model: string; credits: number }>> {
    const rows = await this.prisma.metricBucket.findMany({
      where: {
        dimensionType: 'model',
        metric: 'credits',
        bucketStart: { gte: from, lt: to },
      },
      select: { dimensionId: true, value: true },
    });

    const totals = new Map<string, number>();
    for (const row of rows) {
      const model = row.dimensionId || 'unknown';
      totals.set(model, (totals.get(model) ?? 0) + row.value);
    }
    return [...totals.entries()]
      .map(([model, credits]) => ({ model, credits }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, MAX_MODEL_COSTS);
  }

  private async serviceHealth(now: Date): Promise<AdminServiceHealthDto[]> {
    const names = ['db', 'redis', 'runtime'] as const;
    const checkedAt = now.toISOString();
    try {
      const ready = await this.health.ready();
      return names.map((name) => ({ name, up: ready.checks[name].ok, checkedAt }));
    } catch {
      // 概览不能因为健康探测异常而整体失败。
      return names.map((name) => ({ name, up: false, checkedAt }));
    }
  }

  private async p95(from: Date, to: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ p95: number | null }>>`
      SELECT percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) * 1000
      )::float8 AS p95
      FROM "Run"
      WHERE "status" IN ('done', 'failed')
        AND "endedAt" >= ${from}
        AND "endedAt" < ${to}
    `;
    const value = rows[0]?.p95;
    return value === null || value === undefined ? null : Math.round(Number(value));
  }
}
