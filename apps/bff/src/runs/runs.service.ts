import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { CancelRunResultDto, RetryRunResultDto, RunStatus } from '@ai-office/shared';
import { currentTrace } from '@ai-office/telemetry';
import { TasksService } from '../tasks/tasks.service';
import { RunQueueService } from '../queue/run-queue.service';
import { RUN_CONTROL_BUS, RUN_EVENT_BUS } from '../queue/queue.tokens';
import type { RunControlBus } from '../queue/run-control-bus';
import type { RunEventBus } from '../queue/run-event-bus';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';

/** 已终结的运行不可再取消，重复请求幂等返回当前状态。 */
function isTerminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'canceled';
}

/**
 * 取消运行：排队中的直接移除作业并落库 canceled；
 * 已被执行器接管的只发布控制消息，由执行器自行中止并收尾。
 * 移除或落库落空时必须回查 DB：作业可能已被删除却无人收尾，不能凭假设回报 running。
 * 所有副作用都放在归属校验之后，避免越权用户触发队列/总线操作。
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly queue: RunQueueService,
    @Inject(RUN_CONTROL_BUS) private readonly control: RunControlBus,
    @Inject(RUN_EVENT_BUS) private readonly events: RunEventBus,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}

  async cancel(runId: string, tenantId: string, userId: string): Promise<CancelRunResultDto> {
    const run = await this.tasks.findOwnedRun(runId, tenantId, userId);
    if (isTerminal(run.status)) return { status: run.status as RunStatus };

    if (run.status === 'queued') {
      const removed = await this.queue.remove(runId);
      if (removed && (await this.tasks.markCanceled(runId, run.taskId))) {
        // 先落库再发布：订阅方收到 canceled 会立即回查 DB。
        await this.publishCanceled(runId);
        // 只有本次请求真正促成取消才计数；幂等返回不计，避免重复放大。
        this.metrics.runsCanceled.inc();
        return { status: 'canceled' };
      }
      // 作业已被取走或并发取消已落库：以 DB 为准。终态直接幂等返回；
      // 仍未终态（执行器刚接管）才补发控制消息，避免作业已删除却无人收尾。
      const latest = await this.tasks.findOwnedRun(runId, tenantId, userId);
      if (isTerminal(latest.status)) return { status: latest.status as RunStatus };
    }

    // 条件标记 + 控制消息：先把取消意图落库，执行器即使错过消息也能在执行前兜底。
    await this.tasks.markCancelRequested(runId);
    await this.control.publish(runId, { type: 'cancel' });
    // 控制消息发出即视为取消请求被接受；发布失败会先抛错，不会走到这里。
    this.metrics.runsCanceled.inc();
    return { status: 'running' };
  }

  /**
   * 手动重试：在同一个 Task 上新建一个复用原快照的 Run，并把新 run 入队。
   * 顺序刻意固定为「容量预检 → 建 run → 入队」：容量不足时绝不落新 run，
   * 入队失败时再回滚刚建的行，避免留下永远无人执行的 queued run。
   */
  async retry(runId: string, tenantId: string, userId: string): Promise<RetryRunResultDto> {
    const run = await this.tasks.findOwnedRun(runId, tenantId, userId);
    // 只有失败/取消的运行能重试：排队中或运行中的任务已有作业在途，再建一个会重复执行。
    if (run.status !== 'failed' && run.status !== 'canceled') {
      throw new ConflictException('run_not_retryable');
    }

    // 队列模式下的容量预检；QueueFullError 原样上抛，由控制器映射为 429。
    await this.queue.assertCapacity(tenantId);

    const next = await this.tasks.createRetryRun(
      run.taskId,
      currentTrace()?.traceId ?? null,
    );

    try {
      await this.queue.submit({
        runId: next.runId,
        taskId: next.taskId,
        sessionId: next.sessionId,
        tenantId,
        userId,
      });
    } catch (err) {
      // 作业没能提交：刚建的 run 不会有人执行，必须落库失败，否则前端会一直排队。
      // 用 queued→failed 条件更新而非无条件覆盖：作业可能已写入 Redis 只是响应丢失，
      // worker 随后仍会执行；回滚只清理还没人接手的行。
      // 回滚自身失败只记日志，不能掩盖原始的入队异常（它是给客户端的真正原因）。
      try {
        await this.tasks.failQueuedAttempt(next.runId, next.taskId);
      } catch (finishErr) {
        this.logger.error(
          `run ${next.runId} 重试入队失败后标记 failed 失败: ${(finishErr as Error).message}`,
        );
      }
      throw err;
    }

    // 只有真正入队成功才计数，避免把容量/提交失败也算成一次重试。
    this.metrics.runsRetried.inc();
    return { runId: next.runId, taskId: next.taskId, attempt: next.attempt };
  }

  /** 终态事件发布失败不影响取消结果：DB 已是权威状态，客户端重连可回放。 */
  private async publishCanceled(runId: string): Promise<void> {
    try {
      await this.events.publish(runId, {
        event: 'status',
        data: { runId, status: 'canceled' },
      });
    } catch (err) {
      this.logger.warn(`run ${runId} 发布 canceled 事件失败: ${(err as Error).message}`);
    }
  }
}
