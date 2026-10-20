import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { LEADER_LOCK, type LeaderLock } from '../metrics/leader-lock';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { BUILTIN_ALERT_RULES } from './alert-rules';
import { AlertEvaluator, type AlertRuleRow } from './alert-evaluator';

const LEADER_KEY = 'ai-office:alerts:eval:leader';
const DEFAULT_EVAL_MS = 60_000;
const MIN_EVAL_MS = 5_000;

/** 每 60 秒评估启用规则；Redis 选主，单条规则失败不影响其余规则。 */
@Injectable()
export class AlertSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private seeded = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEADER_LOCK) private readonly lock: LeaderLock,
    private readonly evaluator: AlertEvaluator,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  onModuleInit(): void {
    // 规则播种与评估频率无关：即使关闭评估，管理端也要能看到内置规则。
    void this.seed().catch((err: Error) => {
      this.logger.error(`[alerts] 内置规则写入失败: ${err.message}`);
    });

    const text = process.env.ALERT_EVAL_MS;
    const raw = text === undefined || text.trim() === '' ? DEFAULT_EVAL_MS : Number(text);
    if (raw === 0) {
      this.logger.warn('[alerts] ALERT_EVAL_MS=0，告警评估已关闭');
      return;
    }
    const interval =
      Number.isFinite(raw) && raw > 0 ? Math.max(MIN_EVAL_MS, raw) : DEFAULT_EVAL_MS;
    if (raw !== interval) {
      this.logger.warn(`[alerts] ALERT_EVAL_MS 超出允许范围，已调整为 ${interval}ms`);
    }
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 按 key 幂等补齐内置规则；已存在的不覆盖，保留管理员调整。 */
  async seed(): Promise<void> {
    await this.prisma.alertRule.createMany({
      data: BUILTIN_ALERT_RULES.map((rule) => ({ ...rule })),
      skipDuplicates: true,
    });
    this.seeded = true;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.lock.acquire(LEADER_KEY))) return;
      if (!this.seeded) await this.seed();

      const rules = (await this.prisma.alertRule.findMany({
        where: { enabled: true },
      })) as unknown as AlertRuleRow[];

      for (const rule of rules) {
        try {
          await this.evaluator.evaluate(rule, now);
        } catch (err) {
          this.metrics?.alertEvalFailures.inc();
          this.logger.error(`[alerts] 规则 ${rule.key} 评估失败: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.metrics?.alertEvalFailures.inc();
      this.logger.error(`[alerts] 评估轮次失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
