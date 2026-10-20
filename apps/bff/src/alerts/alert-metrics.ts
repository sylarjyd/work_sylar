import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { HealthService } from '../observability/health.service';
import { RUNTIME_SUMMARY, type RuntimeSummaryProvider } from './runtime-summary.client';

const SETTLE_STUCK_MS = 5 * 60_000;
const RUNTIME_MAX_WINDOW_MINUTES = 60;

interface CountRow {
  status: string;
  _count: { _all: number };
}

interface P95Row {
  p95: number | null;
}

/** 按规则指标读取窗口值；无足够样本时返回 null，评估器据此跳过状态变更。 */
@Injectable()
export class AlertMetricReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
    @Optional()
    @Inject(RUNTIME_SUMMARY)
    private readonly runtime?: RuntimeSummaryProvider,
  ) {}

  async read(metric: string, windowMinutes: number, now = new Date()): Promise<number | null> {
    const from = new Date(now.getTime() - windowMinutes * 60_000);
    switch (metric) {
      case 'service_up':
        return this.serviceUp();
      case 'run_failure_rate':
        return this.failureRate(from, now);
      case 'model_error_rate':
        return this.modelErrorRate(windowMinutes);
      case 'run_latency_p95_ms':
        return this.latencyP95(from, now);
      case 'billing_settle_failures':
        return this.stuckSettlements(from, now);
      case 'credits_per_window':
        return this.credits(from, now);
      default:
        return null;
    }
  }

  private async serviceUp(): Promise<number> {
    const ready = await this.health.ready();
    return ready.status === 'ready' ? 1 : 0;
  }

  private async failureRate(from: Date, now: Date): Promise<number | null> {
    const rows = (await this.prisma.run.groupBy({
      by: ['status'],
      where: {
        endedAt: { gte: from, lt: now },
        status: { in: ['done', 'failed'] },
      },
      _count: { _all: true },
    })) as unknown as CountRow[];

    let done = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === 'failed') failed += row._count._all;
      else if (row.status === 'done') done += row._count._all;
    }
    const total = done + failed;
    return total === 0 ? null : failed / total;
  }

  private async modelErrorRate(windowMinutes: number): Promise<number | null> {
    if (!this.runtime) return null;
    // runtime summary 自身限制在 1–60 分钟；更长窗口由规则层避免使用该指标。
    const summary = await this.runtime.fetch(
      Math.min(RUNTIME_MAX_WINDOW_MINUTES, Math.max(1, windowMinutes)),
    );
    if (!summary || summary.status !== 'ok') return null;
    let requests = 0;
    let errors = 0;
    for (const model of summary.models) {
      requests += model.requests;
      errors += model.errors;
    }
    return requests === 0 ? null : errors / requests;
  }

  private async latencyP95(from: Date, now: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<P95Row[]>`
      SELECT percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) * 1000
      )::float8 AS p95
      FROM "Run"
      WHERE "endedAt" >= ${from} AND "endedAt" < ${now}
        AND "status" IN ('done', 'failed')
    `;
    const value = rows[0]?.p95;
    return value === null || value === undefined ? null : Number(value);
  }

  private async stuckSettlements(from: Date, now: Date): Promise<number> {
    return this.prisma.usageRecord.count({
      where: {
        status: 'pending',
        createdAt: { gte: from, lt: new Date(now.getTime() - SETTLE_STUCK_MS) },
      },
    });
  }

  private async credits(from: Date, now: Date): Promise<number> {
    const agg = await this.prisma.usageRecord.aggregate({
      where: { status: 'settled', createdAt: { gte: from, lt: now } },
      _sum: { credits: true },
    });
    return agg._sum.credits ?? 0;
  }
}
