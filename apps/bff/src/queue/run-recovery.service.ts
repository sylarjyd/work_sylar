import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { TasksService } from '../tasks/tasks.service';
import type { QueueRuntimeConfig } from './queue.config';
import { QUEUE_CONFIG, RUN_CONTROL_BUS, RUN_QUEUE, type RunQueue } from './queue.tokens';
import type { RunControlBus } from './run-control-bus';

/** 运行超过该时长仍 running，且队列作业已丢失，才视为执行进程失联。 */
const STALE_RUN_MS = 10 * 60 * 1000;

/** 取消请求超过该时长仍未生效，认为控制消息可能发在订阅建立之前。 */
const STALE_CANCEL_MS = 2 * 60 * 1000;

/** 周期恢复间隔：取 5 分钟，使失联运行最迟在阈值后约 5 分钟内被扫到。 */
export const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

/** 这些终态说明作业不会再被投递，对应的 running 运行已经无人执行。 */
const LOST_STATES = new Set(['completed', 'failed']);

/**
 * 启动 + 周期恢复（仅队列模式）。
 *
 * 两类问题靠定时扫描兜底：
 * 1. worker 崩溃/作业被清理后，run 仍停在 running，预占额度不归还；
 * 2. 取消控制消息发布早于执行器订阅，取消请求落库后一直不生效。
 *
 * 判断「作业是否还会被投递」是这里的关键：只要 Redis 里还能看到 waiting/active
 * 等状态，就不能动这个 run，否则会把正在执行的作业误杀。
 */
@Injectable()
export class RunRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RunRecoveryService.name);
  private timer?: NodeJS.Timeout;
  /** 上一轮尚未结束时跳过下一轮，避免慢扫描期间堆叠多重收尾。 */
  private running = false;

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueRuntimeConfig,
    @Optional() @Inject(RUN_QUEUE) private readonly queue: RunQueue | null,
    private readonly tasks: TasksService,
    private readonly billing: BillingService,
    @Inject(RUN_CONTROL_BUS) private readonly control: RunControlBus,
  ) {}

  onApplicationBootstrap(): void {
    // 内联执行没有作业会丢失，也没有控制消息窗口，无需恢复扫描。
    if (!this.config.enabled || !this.queue) return;
    void this.recover();
    this.timer = setInterval(() => void this.recover(), RECOVERY_INTERVAL_MS);
    // 不阻止进程退出（测试/短生命周期命令）。
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 执行一轮恢复；重复调用（定时器重入）直接跳过上一轮未完成的扫描。 */
  async recover(now = new Date()): Promise<void> {
    const queue = this.queue;
    if (!this.config.enabled || !queue) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverLostRuns(queue, now);
      await this.republishCancelRequests(now);
    } catch (err) {
      // 顶层查询失败（如 DB 不可用）不能让本轮未捕获的 rejection 逃逸：
      // 启动时的 void 调用与定时器回调都没有调用方接住，Node 会直接退出进程。
      this.logger.error(`[recovery] 本轮恢复扫描失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** 回收队列作业已丢失的 running 运行：先释放预占，再条件落 failed。 */
  private async recoverLostRuns(queue: RunQueue, now: Date): Promise<void> {
    const runs = await this.tasks.listStaleRunningRuns(
      new Date(now.getTime() - STALE_RUN_MS),
    );
    for (const run of runs) {
      try {
        const state = await this.readJobState(queue, run.id);
        // null = 作业已不存在；completed/failed = 不会再投递。其余状态
        // （waiting/delayed/active/prioritized/waiting-children，以及无法识别的
        // unknown）都说明作业还有可能被执行，不能在此处收尾。
        const lost = state === null || LOST_STATES.has(state);
        if (!lost) continue;

        // 先归还预占再做状态收尾：即使状态落库失败，额度也不会被永久占用。
        await this.billing.releaseHold(run.id);
        const failed = await this.tasks.failStaleRun(run.id, run.taskId, 'worker_lost');
        // 条件更新落空说明 run 恰好在扫描期间正常结束，不需要也不应该再告警。
        if (failed) {
          this.logger.warn(`[recovery] 回收失联运行 run=${run.id} task=${run.taskId}`);
        }
      } catch (err) {
        // 单行异常隔离：一条坏数据或一次 Redis 抖动不能中断整轮扫描。
        this.logger.error(`[recovery] 回收运行失败 run=${run.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 读取作业状态；null 表示作业不存在。
   * Redis 不可用时返回 'unknown' 让调用方按「不可判定」跳过——宁可下一轮再试，
   * 也绝不能因为 Redis 故障把仍在正常执行的运行误判为失联。
   */
  private async readJobState(queue: RunQueue, runId: string): Promise<string | null> {
    try {
      const job = await queue.getJob(runId);
      if (!job) return null;
      return await job.getState();
    } catch (err) {
      this.logger.warn(`[recovery] 查询队列作业失败 run=${runId}: ${(err as Error).message}`);
      return 'unknown';
    }
  }

  /** 重发陈旧的取消请求；单条发布失败不影响其余运行。 */
  private async republishCancelRequests(now: Date): Promise<void> {
    const runs = await this.tasks.listStaleCancelRequests(
      new Date(now.getTime() - STALE_CANCEL_MS),
    );
    for (const run of runs) {
      try {
        // 控制消息是尽力而为：执行器还会在执行前/轮次间重读 DB 的 cancelRequestedAt，
        // 重发主要用于补上「消息发布早于订阅建立」的窗口。
        await this.control.publish(run.id, { type: 'cancel' });
      } catch (err) {
        this.logger.warn(`[recovery] 重发取消请求失败 run=${run.id}: ${(err as Error).message}`);
      }
    }
  }
}
