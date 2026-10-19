import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BillingService } from './billing.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 计费补偿：每分钟结算陈旧 pending、清理孤儿预占；每天扫描过期批次。 */
@Injectable()
export class BillingSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingSweeper.name);
  private timer?: NodeJS.Timeout;
  private lastExpireScan = 0;

  constructor(private readonly billing: BillingService) {}

  onModuleInit(): void {
    const raw = Number(process.env.BILLING_SWEEP_MS ?? 60000);
    if (!Number.isFinite(raw) || raw <= 0) return;
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
    try {
      await this.billing.settleStalePending(new Date(now.getTime() - 60_000));
    } catch (err) {
      this.logger.error(`[billing] 补偿结算扫描失败: ${(err as Error).message}`);
    }
    try {
      await this.billing.sweepOrphanHolds(now);
    } catch (err) {
      this.logger.error(`[billing] 孤儿预占扫描失败: ${(err as Error).message}`);
    }
    if (now.getTime() - this.lastExpireScan >= DAY_MS) {
      this.lastExpireScan = now.getTime();
      try {
        await this.billing.sweepExpired(now);
      } catch (err) {
        this.logger.error(`[billing] 过期批次扫描失败: ${(err as Error).message}`);
      }
    }
  }
}
