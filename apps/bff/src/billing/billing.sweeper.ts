import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 补偿扫描默认间隔；可由 BILLING_SWEEP_MS 覆盖。 */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** 创建超过该时长仍 pending 的用量视为陈旧，需要补偿结算。 */
const STALE_PENDING_MS = 60_000;

/** 计费补偿：每分钟结算陈旧 pending、清理孤儿预占；每天扫描过期批次。 */
@Injectable()
export class BillingSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingSweeper.name);
  private timer?: NodeJS.Timeout;
  private lastExpireScan = 0;
  /** setInterval 在单轮耗时超过间隔时会并发进入下一轮，用运行时标志防止重入。 */
  private running = false;

  constructor(
    private readonly billing: BillingService,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  onModuleInit(): void {
    const raw = Number(process.env.BILLING_SWEEP_MS ?? DEFAULT_SWEEP_INTERVAL_MS);
    if (!Number.isFinite(raw) || raw <= 0) {
      // onModuleInit 每个实例只执行一次，因此该告警天然只打一次。
      this.logger.warn(`[billing] BILLING_SWEEP_MS 配置非法（${process.env.BILLING_SWEEP_MS}），补偿扫描已禁用`);
      return;
    }
    // 防止误配成 1ms 打爆数据库：下限夹到 1s。
    const interval = Math.max(1000, raw);
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出（测试/短生命周期命令）。
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 两步都会对账本行加锁，但各自异常隔离（不会向对方抛出），可安全并行，
      // 避免一轮中某个慢步骤拖住另一个、造成积压。
      await Promise.all([
        this.billing
          .settleStalePending(new Date(now.getTime() - STALE_PENDING_MS))
          .catch((err) => {
            this.metrics?.billingSettleFailures.inc();
            this.logger.error(`[billing] 补偿结算扫描失败: ${(err as Error).message}`);
          }),
        this.billing.sweepOrphanHolds(now).catch((err) => {
          this.metrics?.billingSettleFailures.inc();
          this.logger.error(`[billing] 孤儿预占扫描失败: ${(err as Error).message}`);
        }),
      ]);
      // lastExpireScan 初始为 0，首次 tick 即执行一次全量过期扫描；此后每 24h 一次。
      if (now.getTime() - this.lastExpireScan >= DAY_MS) {
        this.lastExpireScan = now.getTime();
        try {
          await this.billing.sweepExpired(now);
        } catch (err) {
          this.logger.error(`[billing] 过期批次扫描失败: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
