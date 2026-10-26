import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DelayedError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { SettingsService } from '../settings/settings.service';
import { TasksService } from '../tasks/tasks.service';
import type { QueueRuntimeConfig } from './queue.config';
import { QUEUE_CONFIG, RUN_QUEUE, type RunQueue } from './queue.tokens';
import { RUN_REDIS } from './redis.provider';
import { RunExecutor } from './run-executor.service';
import type { RunJob } from './run-job';

/** 单租户并发已满时让位的延迟时长；到点后由 BullMQ 重新投递。 */
const TENANT_BACKOFF_MS = 2000;

/** 队列深度对账周期：inc/dec 会因崩溃、取消、多副本而漂移，定时以 Redis 实况纠正。 */
const DEPTH_RECONCILE_MS = 30_000;

/** 等待在途作业结束的上限；超时后强制断开后端连接，避免 SIGTERM 被长任务无限拖住。 */
export const WORKER_CLOSE_TIMEOUT_MS = 15_000;

/**
 * 以本次开始处理时间减入队时间；延迟让位与重试同样计入等待。
 * processedOn 缺失时回退当前时间，时钟回拨则夹到 0，保证观测值非负。
 */
export function runQueueWaitSeconds(job: {
  timestamp: number;
  processedOn?: number | null;
}): number {
  const startedAt = job.processedOn ?? Date.now();
  return Math.max(0, startedAt - job.timestamp) / 1000;
}

/**
 * 运行队列消费者：仅队列启用时创建 Worker，否则整体空转。
 * 处理器自己保证不抛错（执行器内部收尾），failed 事件只统计真正的框架级失败。
 */
@Injectable()
export class RunWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RunWorker.name);
  private worker: Worker<RunJob, void, 'run'> | null = null;
  private depthTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueRuntimeConfig,
    @Optional() @Inject(RUN_REDIS) private readonly redis: Redis | null,
    @Optional() @Inject(RUN_QUEUE) private readonly queue: RunQueue | null,
    private readonly executor: RunExecutor,
    private readonly tasks: TasksService,
    private readonly settings: SettingsService,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled || !this.redis) return;

    this.worker = new Worker<RunJob, void, 'run'>(
      this.config.name,
      async (job) => {
        const config = await this.settings.getQueueConfig();
        // 崩溃重投时本作业的 Task 仍是 running，按租户计数会把自身算进去；
        // 排除自身任务，否则 perTenantConcurrency=1 时作业会永久自锁。
        const active = await this.tasks.countRunning(job.data.tenantId, job.data.taskId);
        if (active >= config.perTenantConcurrency) {
          // 让位：作业退回延迟队列，不消耗尝试次数，也不占用 worker 并发。
          // worker 在处理器内保证已设置 job.token，这里用它防止锁失效后误移动。
          await job.moveToDelayed(Date.now() + TENANT_BACKOFF_MS, job.token!);
          throw new DelayedError();
        }

        // 在真正开始执行时记录：让位重投的作业会在下一次尝试把累计等待一次性计入。
        this.metrics.runQueueWait.observe(runQueueWaitSeconds(job));
        this.metrics.runQueueActive.inc();
        try {
          await this.executor.execute(job.data);
        } finally {
          this.metrics.runQueueActive.dec();
        }
      },
      {
        connection: this.redis,
        concurrency: this.config.concurrency,
        maxStalledCount: 1,
      },
    );

    this.worker.on('failed', () => {
      this.metrics.runsQueueFailures.inc();
    });
    // 没有 error 监听器时 EventEmitter 会升级为未捕获异常，必须兜底记录。
    this.worker.on('error', (err) => {
      this.logger.error(`队列连接错误: ${err.message}`);
    });

    if (this.queue) {
      void this.reconcileDepth();
      this.depthTimer = setInterval(() => void this.reconcileDepth(), DEPTH_RECONCILE_MS);
      this.depthTimer.unref();
    }

    this.logger.log(`运行队列 ${this.config.name} 已启动（并发 ${this.config.concurrency}）`);
  }

  /** 以 Redis 实况对账队列深度；失败只记日志，不影响 worker 主流程。 */
  private async reconcileDepth(): Promise<void> {
    if (!this.queue) return;
    try {
      const counts = await this.queue.getJobCounts('waiting', 'delayed');
      this.metrics.runQueueDepth.set((counts.waiting ?? 0) + (counts.delayed ?? 0));
    } catch (err) {
      this.logger.debug(`队列深度对账失败: ${(err as Error).message}`);
    }
  }

  /**
   * 停止拉取并等待在途作业结束；重复调用幂等。
   * worker.close() 会等待在途处理器（最长可达数分钟），关闭路径必须有上限，
   * 超时后强制断开后端连接，避免 SIGTERM 被长任务拖住。
   */
  async close(): Promise<void> {
    // 先停对账定时器，否则关闭期间仍会访问即将断开的连接。
    if (this.depthTimer) {
      clearInterval(this.depthTimer);
      this.depthTimer = null;
    }

    const worker = this.worker;
    this.worker = null;
    if (!worker) return;

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        // 不传 force：先礼后兵，给在途作业收尾的机会。
        worker.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('close_timeout'));
          }, WORKER_CLOSE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (err) {
      if (timedOut) {
        this.logger.warn('worker 关闭超时，强制断开连接');
        // BullMQ 的 close 是幂等的：首次 close() 已缓存 closing Promise，二次
        // close(true) 只会返回同一个「非强制关闭」的 Promise，force 参数被忽略。
        // 因此超时后不能再次 close(true)，必须直接断开后端连接（普通连接与
        // blocking 连接），否则 SIGTERM 仍会被最长达数分钟的在途流拖住。
        const backend = (
          worker as unknown as {
            backend?: { disconnect?: () => Promise<void> };
          }
        ).backend;
        await backend?.disconnect?.().catch(() => undefined);
      } else {
        this.logger.warn(`关闭运行 worker 失败: ${(err as Error).message}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
