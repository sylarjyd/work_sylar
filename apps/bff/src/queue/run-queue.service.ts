import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { SettingsService } from '../settings/settings.service';
import { TasksService } from '../tasks/tasks.service';
import type { QueueRuntimeConfig } from './queue.config';
import { QUEUE_CONFIG, RUN_JOB_NAME, RUN_QUEUE, type RunQueue } from './queue.tokens';
import { RunExecutor } from './run-executor.service';
import type { RunJob } from './run-job';

/** 单租户排队数达到上限时抛出；控制器据此返回 429。 */
export class QueueFullError extends Error {
  readonly code = 'queue_full';

  constructor(readonly tenantId: string) {
    super('queue_full');
    this.name = 'QueueFullError';
  }
}

/**
 * 运行入队入口：配置了 Redis 时入队，否则降级为进程内执行。
 * 入队只做准入与排队上限校验，真正的额度预占由 worker 在执行前完成。
 */
@Injectable()
export class RunQueueService {
  private readonly logger = new Logger(RunQueueService.name);

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueRuntimeConfig,
    @Optional() @Inject(RUN_QUEUE) private readonly queue: RunQueue | null,
    private readonly executor: RunExecutor,
    private readonly tasks: TasksService,
    private readonly settings: SettingsService,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}

  /** 提交运行：返回实际采用的执行方式，调用方无需关心队列是否可用。 */
  async submit(job: RunJob): Promise<'queued' | 'inline'> {
    if (this.config.enabled && this.queue) {
      await this.enqueue(job);
      return 'queued';
    }
    // 不阻塞 HTTP 响应；内联执行与请求生命周期解耦，失败自行落库收尾。
    void this.executor.execute(job).catch((err: unknown) => {
      this.logger.error(`run ${job.runId} 内联执行异常: ${(err as Error).message}`);
    });
    return 'inline';
  }

  /** 入队；排队上限是软上限，并发提交可能短暂超出，由执行侧并发控制兜底。 */
  async enqueue(job: RunJob): Promise<void> {
    if (!this.queue) throw new Error('queue_disabled');
    const config = await this.settings.getQueueConfig();
    const queued = await this.tasks.countQueued(job.tenantId);
    if (queued >= config.maxPerTenant) throw new QueueFullError(job.tenantId);

    // jobId 复用 runId：重复提交天然幂等；终态作业保留少量样本便于排查。
    await this.queue.add(RUN_JOB_NAME, job, {
      jobId: job.runId,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    this.metrics.runsEnqueued.inc();
    this.metrics.runQueueDepth.inc();
  }

  /**
   * 移除尚未开始执行的作业（取消路径使用）。
   * 作业已被 worker 取走时 remove 会失败，返回 false 交由执行侧控制总线处理；
   * 这里不调整 depth，取消后的指标回收由后续清理任务统一处理。
   */
  async remove(runId: string): Promise<boolean> {
    if (!this.queue) return false;
    try {
      const job = await this.queue.getJob(runId);
      if (!job) return false;
      await job.remove();
      // 复查：remove 返回后作业必须确实消失，避免把竞态当成成功。
      return (await this.queue.getJob(runId)) == null;
    } catch (err) {
      this.logger.warn(`run ${runId} 移除排队作业失败: ${(err as Error).message}`);
      return false;
    }
  }
}
