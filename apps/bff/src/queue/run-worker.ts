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
import { QUEUE_CONFIG } from './queue.tokens';
import { RUN_REDIS } from './redis.provider';
import { RunExecutor } from './run-executor.service';
import type { RunJob } from './run-job';

/** 单租户并发已满时让位的延迟时长；到点后由 BullMQ 重新投递。 */
const TENANT_BACKOFF_MS = 2000;

/**
 * 运行队列消费者：仅队列启用时创建 Worker，否则整体空转。
 * 处理器自己保证不抛错（执行器内部收尾），failed 事件只统计真正的框架级失败。
 */
@Injectable()
export class RunWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RunWorker.name);
  private worker: Worker<RunJob, void, 'run'> | null = null;

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueRuntimeConfig,
    @Optional() @Inject(RUN_REDIS) private readonly redis: Redis | undefined,
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
        const active = await this.tasks.countRunning(job.data.tenantId);
        if (active >= config.perTenantConcurrency) {
          // 让位：作业退回延迟队列，不消耗尝试次数，也不占用 worker 并发。
          // worker 在处理器内保证已设置 job.token，这里用它防止锁失效后误移动。
          await job.moveToDelayed(Date.now() + TENANT_BACKOFF_MS, job.token!);
          throw new DelayedError();
        }

        this.metrics.runQueueActive.inc();
        try {
          await this.executor.execute(job.data);
        } finally {
          this.metrics.runQueueActive.dec();
          // 取消等未走完整处理路径的作业可能造成 depth 漂移，由后续清理任务兜底。
          this.metrics.runQueueDepth.dec();
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
    this.logger.log(`运行队列 ${this.config.name} 已启动（并发 ${this.config.concurrency}）`);
  }

  /** 停止拉取并等待在途作业结束；重复调用幂等。 */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      await worker.close();
    } catch (err) {
      this.logger.warn(`关闭运行 worker 失败: ${(err as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
