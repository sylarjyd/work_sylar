import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CancelRunResultDto, RunStatus } from '@ai-office/shared';
import { TasksService } from '../tasks/tasks.service';
import { RunQueueService } from '../queue/run-queue.service';
import { RUN_CONTROL_BUS, RUN_EVENT_BUS } from '../queue/queue.tokens';
import type { RunControlBus } from '../queue/run-control-bus';
import type { RunEventBus } from '../queue/run-event-bus';

/** 已终结的运行不可再取消，重复请求幂等返回当前状态。 */
function isTerminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'canceled';
}

/**
 * 取消运行：排队中的直接移除作业并落库 canceled；
 * 已被执行器接管的只发布控制消息，由执行器自行中止并收尾。
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
  ) {}

  async cancel(runId: string, tenantId: string, userId: string): Promise<CancelRunResultDto> {
    const run = await this.tasks.findOwnedRun(runId, tenantId, userId);
    if (isTerminal(run.status)) return { status: run.status as RunStatus };

    if (run.status === 'queued') {
      const removed = await this.queue.remove(runId);
      if (removed) {
        const updated = await this.tasks.markCanceled(runId, run.taskId);
        if (updated) {
          // 先落库再发布：订阅方收到 canceled 会立即回查 DB。
          await this.publishCanceled(runId);
          return { status: 'canceled' };
        }
        // 作业已被 worker 抢走，执行器会按自己的节奏收尾。
        return { status: 'running' };
      }
      // remove 失败说明作业已 active：降级为控制消息，走执行中取消路径。
    }

    // 条件标记 + 控制消息：先把取消意图落库，执行器即使错过消息也能在执行前兜底。
    await this.tasks.markCancelRequested(runId);
    await this.control.publish(runId, { type: 'cancel' });
    return { status: 'running' };
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
