import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ModelPriceDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { LEADER_LOCK, type LeaderLock } from './leader-lock';
import {
  aggregateRunEnds,
  aggregateRunStarts,
  aggregateToolCalls,
  aggregateUsage,
  HOUR_MS,
  hourStartOf,
  type RunEndRow,
  type RunStartRow,
  type UsageRollupRow,
} from './rollup';

const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 300_000;
const MIN_INTERVAL_MS = 10_000;
const LEADER_KEY = 'ai-office:metrics:rollup:leader';
const PURGE_BATCH_SIZE = 5000;
const MAX_PURGE_BATCHES = 100;

function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** 小时级快照：启动补算 + 每 5 分钟重算最近两个完整小时；每日清理过期数据。 */
@Injectable()
export class MetricsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private backfilled = false;
  private lastPurgeAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEADER_LOCK) private readonly lock: LeaderLock,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  onModuleInit(): void {
    const text = process.env.METRICS_ROLLUP_MS;
    const raw = text === undefined || text.trim() === '' ? DEFAULT_INTERVAL_MS : Number(text);
    // 0 是显式关闭开关，不能退化成默认 5 分钟。
    if (raw === 0) {
      this.logger.warn('[metrics] METRICS_ROLLUP_MS=0，快照任务已关闭');
      return;
    }
    const interval =
      Number.isFinite(raw) && raw > 0 ? Math.max(MIN_INTERVAL_MS, raw) : DEFAULT_INTERVAL_MS;
    if (raw !== interval) {
      this.logger.warn(`[metrics] METRICS_ROLLUP_MS 超出允许范围，已调整为 ${interval}ms`);
    }
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出（测试/短生命周期命令）。
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // 选主 Redis 连接可能由 factory 创建，显式释放，避免关闭后事件循环不退出。
    this.lock.close?.();
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.lock.acquire(LEADER_KEY))) return;

      // 首次执行补算配置的历史窗口；之后每轮只重算最近两个完整小时，
      // 容忍延迟结算，同时避免每分钟扫全表。
      const hours = this.backfilled ? 2 : this.intEnv('METRICS_BACKFILL_HOURS', 24, 1, 168);
      await this.recomputeHours(hours, now);
      this.backfilled = true;

      if (now.getTime() - this.lastPurgeAt >= DAY_MS) {
        this.lastPurgeAt = now.getTime();
        await this.purgeRetention(now);
      }
    } catch (err) {
      this.metrics?.rollupFailures.inc();
      this.logger.error(`[metrics] 快照任务失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** 删除早于保留期的快照与告警事件；各自每批 5000 行，单轮最多 100 批。 */
  async purgeRetention(now = new Date()): Promise<void> {
    const metricCutoff = new Date(
      now.getTime() - this.intEnv('METRICS_RETENTION_DAYS', 90, 1, 3650) * DAY_MS,
    );
    const alertCutoff = new Date(
      now.getTime() - this.intEnv('ALERT_RETENTION_DAYS', 90, 1, 3650) * DAY_MS,
    );
    await this.purgeMetricBuckets(metricCutoff);
    await this.purgeAlertEvents(alertCutoff);
  }

  private async purgeMetricBuckets(cutoff: Date): Promise<void> {
    for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
      const rows = await this.prisma.metricBucket.findMany({
        where: { bucketStart: { lt: cutoff } },
        select: { id: true },
        take: PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) return;
      // 同时带上 cutoff：查询与删除之间若快照被重算成新桶，也不会误删。
      await this.prisma.metricBucket.deleteMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          bucketStart: { lt: cutoff },
        },
      });
      if (rows.length < PURGE_BATCH_SIZE) return;
    }
    this.logger.warn(
      `[metrics] 单轮快照清理达到上限 ${MAX_PURGE_BATCHES * PURGE_BATCH_SIZE} 行，剩余留待下一轮`,
    );
  }

  private async purgeAlertEvents(cutoff: Date): Promise<void> {
    for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
      const rows = await this.prisma.alertEvent.findMany({
        where: { startedAt: { lt: cutoff } },
        select: { id: true },
        take: PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) return;
      await this.prisma.alertEvent.deleteMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          startedAt: { lt: cutoff },
        },
      });
      if (rows.length < PURGE_BATCH_SIZE) return;
    }
    this.logger.warn(
      `[metrics] 单轮告警清理达到上限 ${MAX_PURGE_BATCHES * PURGE_BATCH_SIZE} 行，剩余留待下一轮`,
    );
  }

  private async recomputeHours(hours: number, now: Date): Promise<void> {
    const currentHour = hourStartOf(now).getTime();
    for (let offset = hours; offset >= 1; offset--) {
      await this.recomputeHour(new Date(currentHour - offset * HOUR_MS));
    }
  }

  private async recomputeHour(bucketStart: Date): Promise<void> {
    const end = new Date(bucketStart.getTime() + HOUR_MS);
    // allSettled 等所有查询落地再抛错：Promise.all 在多个查询同时失败时会把
    // 后续 rejection 留成 unhandledRejection，生产上可能直接终止进程。
    const [startsR, endsR, usageR, toolsR, pricesR] = await Promise.allSettled([
      this.query(() =>
        this.prisma.run.findMany({
          where: { startedAt: { gte: bucketStart, lt: end } },
          select: {
            id: true,
            startedAt: true,
            task: { select: { session: { select: { tenantId: true } } } },
          },
        }),
      ),
      this.query(() =>
        this.prisma.run.findMany({
          where: {
            endedAt: { gte: bucketStart, lt: end },
            status: { in: ['done', 'failed'] },
          },
          select: {
            id: true,
            status: true,
            startedAt: true,
            endedAt: true,
            task: { select: { session: { select: { tenantId: true } } } },
          },
        }),
      ),
      this.query(() =>
        this.prisma.usageRecord.findMany({
          where: { createdAt: { gte: bucketStart, lt: end } },
          select: {
            tenantId: true,
            models: true,
            inputTokens: true,
            outputTokens: true,
            credits: true,
          },
        }),
      ),
      this.query(() =>
        this.prisma.step.findMany({
          where: { ts: { gte: bucketStart, lt: end }, type: 'tool_result' },
          select: { payload: true },
        }),
      ),
      this.query(() =>
        this.prisma.modelPrice.findMany({
          select: {
            model: true,
            inputMilliCreditsPer1k: true,
            outputMilliCreditsPer1k: true,
          },
        }),
      ),
    ]);
    const starts = unwrapSettled(startsR);
    const ends = unwrapSettled(endsR);
    const usage = unwrapSettled(usageR);
    const tools = unwrapSettled(toolsR);
    const prices = unwrapSettled(pricesR);

    const startRows: RunStartRow[] = starts.map((row) => ({
      tenantId: row.task.session.tenantId,
      startedAt: row.startedAt,
    }));
    const endRows: RunEndRow[] = [];
    for (const row of ends) {
      if (!row.endedAt) continue;
      endRows.push({
        tenantId: row.task.session.tenantId,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      });
    }
    const usageRows: UsageRollupRow[] = usage.map((row) => ({
      tenantId: row.tenantId,
      models: row.models,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      credits: row.credits,
    }));
    const priceMap: Record<string, ModelPriceDto> = {};
    for (const price of prices) {
      priceMap[price.model] = {
        inputMilliCreditsPer1k: price.inputMilliCreditsPer1k,
        outputMilliCreditsPer1k: price.outputMilliCreditsPer1k,
      };
    }

    const buckets = [
      ...aggregateRunStarts(startRows, bucketStart),
      ...aggregateRunEnds(endRows, bucketStart),
      ...aggregateUsage(usageRows, priceMap, bucketStart),
      ...aggregateToolCalls(tools, bucketStart),
    ];
    if (buckets.length === 0) return;

    await this.prisma.$transaction(
      buckets.map((bucket) =>
        this.prisma.metricBucket.upsert({
          where: {
            bucketStart_metric_dimensionType_dimensionId: {
              bucketStart: bucket.bucketStart,
              metric: bucket.metric,
              dimensionType: bucket.dimensionType,
              dimensionId: bucket.dimensionId,
            },
          },
          create: bucket,
          update: { value: bucket.value, count: bucket.count },
        }),
      ),
    );
  }

  /** 把同步抛错也转成 rejection：否则前面已创建的查询 Promise 会变成 unhandled。 */
  private query<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.resolve().then(fn);
  }

  private intEnv(name: string, fallback: number, min: number, max: number): number {
    const text = process.env[name];
    if (text === undefined || text.trim() === '') return fallback;
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }
}
