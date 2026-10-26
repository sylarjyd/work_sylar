import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { RunsService } from './runs.service';
import type { TasksService } from '../tasks/tasks.service';
import type { RunQueueService } from '../queue/run-queue.service';
import type { RunControlBus } from '../queue/run-control-bus';
import type { RunEventBus } from '../queue/run-event-bus';
import { createBffMetrics } from '../observability/observability.metrics';

interface Deps {
  tasks: {
    findOwnedRun: ReturnType<typeof vi.fn>;
    markCanceled: ReturnType<typeof vi.fn>;
    markCancelRequested: ReturnType<typeof vi.fn>;
    createRetryRun: ReturnType<typeof vi.fn>;
    failQueuedAttempt: ReturnType<typeof vi.fn>;
  };
  queue: {
    remove: ReturnType<typeof vi.fn>;
    assertCapacity: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
  };
  control: { publish: ReturnType<typeof vi.fn> };
  events: { publish: ReturnType<typeof vi.fn> };
}

/** 构造归属查询返回的行，供默认实现与回查用例复用。 */
function runRow(status: string) {
  return { id: 'r1', taskId: 'task1', status, cancelRequestedAt: null };
}

/** 按给定 run 状态构造服务；findOwnedRun 默认返回本人 r1/task1。 */
function makeService(
  run: { status: string; cancelRequestedAt?: Date | null } | Error,
): { svc: RunsService; deps: Deps; metrics: ReturnType<typeof createBffMetrics> } {
  const deps: Deps = {
    tasks: {
      findOwnedRun: vi.fn(),
      markCanceled: vi.fn().mockResolvedValue(true),
      markCancelRequested: vi.fn().mockResolvedValue(undefined),
      createRetryRun: vi.fn().mockResolvedValue({
        runId: 'r2',
        taskId: 'task1',
        sessionId: 's1',
        attempt: 2,
      }),
      failQueuedAttempt: vi.fn().mockResolvedValue(true),
    },
    queue: {
      remove: vi.fn().mockResolvedValue(true),
      assertCapacity: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn().mockResolvedValue('queued'),
    },
    control: { publish: vi.fn().mockResolvedValue(undefined) },
    events: { publish: vi.fn().mockResolvedValue(undefined) },
  };
  if (run instanceof Error) {
    deps.tasks.findOwnedRun.mockRejectedValue(run);
  } else {
    deps.tasks.findOwnedRun.mockResolvedValue({
      ...runRow(run.status),
      cancelRequestedAt: run.cancelRequestedAt ?? null,
    });
  }
  const metrics = createBffMetrics({ defaultMetrics: false });
  const svc = new RunsService(
    deps.tasks as unknown as TasksService,
    deps.queue as unknown as RunQueueService,
    deps.control as unknown as RunControlBus,
    deps.events as unknown as RunEventBus,
    metrics,
  );
  return { svc, deps, metrics };
}

describe('RunsService.cancel', () => {
  it('取消排队中运行：移除 job 并置 canceled，随后发布终态', async () => {
    const { svc, deps } = makeService({ status: 'queued' });

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'canceled' });

    expect(deps.queue.remove).toHaveBeenCalledWith('r1');
    expect(deps.tasks.markCanceled).toHaveBeenCalledWith('r1', 'task1');
    expect(deps.tasks.markCancelRequested).not.toHaveBeenCalled();
    expect(deps.control.publish).not.toHaveBeenCalled();
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'status',
      data: { runId: 'r1', status: 'canceled' },
    });
    // 先落库再发布：订阅方收到事件时会立即回查 DB，必须已可见 canceled。
    expect(deps.tasks.markCanceled.mock.invocationCallOrder[0]).toBeLessThan(
      deps.events.publish.mock.invocationCallOrder[0]!,
    );
  });

  it('取消执行中运行：只发布控制消息并记录取消请求，状态保持 running', async () => {
    const { svc, deps } = makeService({ status: 'running' });

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'running' });

    expect(deps.tasks.markCancelRequested).toHaveBeenCalledWith('r1');
    expect(deps.control.publish).toHaveBeenCalledWith('r1', { type: 'cancel' });
    expect(deps.queue.remove).not.toHaveBeenCalled();
    expect(deps.tasks.markCanceled).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('终态幂等返回当前状态，不产生任何副作用', async () => {
    for (const status of ['done', 'failed', 'canceled'] as const) {
      const { svc, deps } = makeService({ status });
      await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status });
      expect(deps.queue.remove).not.toHaveBeenCalled();
      expect(deps.tasks.markCancelRequested).not.toHaveBeenCalled();
      expect(deps.control.publish).not.toHaveBeenCalled();
      expect(deps.events.publish).not.toHaveBeenCalled();
    }
  });

  it('run 不存在或不属于本人时原样抛出 404，且不产生副作用', async () => {
    const { svc, deps } = makeService(new NotFoundException('run_not_found'));

    await expect(svc.cancel('r1', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.queue.remove).not.toHaveBeenCalled();
    expect(deps.control.publish).not.toHaveBeenCalled();
  });

  it('排队作业已被 worker 取走（remove=false）且回查仍未终态时降级为控制消息', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    deps.queue.remove.mockResolvedValue(false);

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'running' });
    expect(deps.tasks.markCanceled).not.toHaveBeenCalled();
    expect(deps.tasks.findOwnedRun).toHaveBeenCalledTimes(2);
    expect(deps.tasks.markCancelRequested).toHaveBeenCalledWith('r1');
    expect(deps.control.publish).toHaveBeenCalledWith('r1', { type: 'cancel' });
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('remove=false 且回查已 canceled（并发取消已落库）时幂等返回 canceled', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    deps.queue.remove.mockResolvedValue(false);
    deps.tasks.findOwnedRun
      .mockResolvedValueOnce(runRow('queued'))
      .mockResolvedValueOnce(runRow('canceled'));

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'canceled' });
    expect(deps.tasks.markCanceled).not.toHaveBeenCalled();
    expect(deps.tasks.markCancelRequested).not.toHaveBeenCalled();
    expect(deps.control.publish).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('markCanceled=false 且回查仍 running（执行器刚接管）时补发控制消息', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    deps.tasks.markCanceled.mockResolvedValue(false);
    deps.tasks.findOwnedRun
      .mockResolvedValueOnce(runRow('queued'))
      .mockResolvedValueOnce(runRow('running'));

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'running' });
    expect(deps.tasks.findOwnedRun).toHaveBeenCalledTimes(2);
    expect(deps.tasks.markCancelRequested).toHaveBeenCalledWith('r1');
    expect(deps.control.publish).toHaveBeenCalledWith('r1', { type: 'cancel' });
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('markCanceled=false 且回查已 canceled（并发取消已落库）时直接返回 canceled', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    deps.tasks.markCanceled.mockResolvedValue(false);
    deps.tasks.findOwnedRun
      .mockResolvedValueOnce(runRow('queued'))
      .mockResolvedValueOnce(runRow('canceled'));

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'canceled' });
    expect(deps.tasks.markCancelRequested).not.toHaveBeenCalled();
    expect(deps.control.publish).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('markCanceled 抛错（DB 故障）时原样上抛，不伪报 running', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    const dbError = new Error('db down');
    deps.tasks.markCanceled.mockRejectedValue(dbError);

    await expect(svc.cancel('r1', 't1', 'u1')).rejects.toBe(dbError);
    expect(deps.tasks.markCancelRequested).not.toHaveBeenCalled();
    expect(deps.control.publish).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });
});

describe('RunsService.retry', () => {
  it('失败的运行可重试：预检→建 run→入队，并计数一次', async () => {
    const { svc, deps, metrics } = makeService({ status: 'failed' });
    const inc = vi.spyOn(metrics.runsRetried, 'inc');

    await expect(svc.retry('r1', 't1', 'u1')).resolves.toEqual({
      runId: 'r2',
      taskId: 'task1',
      attempt: 2,
    });

    expect(deps.queue.assertCapacity).toHaveBeenCalledWith('t1');
    expect(deps.tasks.createRetryRun).toHaveBeenCalledTimes(1);
    const [taskArg, traceArg] = deps.tasks.createRetryRun.mock.calls[0];
    expect(taskArg).toBe('task1');
    expect(traceArg === null || typeof traceArg === 'string').toBe(true);
    expect(deps.queue.submit).toHaveBeenCalledTimes(1);
    expect(deps.queue.submit).toHaveBeenCalledWith({
      runId: 'r2',
      taskId: 'task1',
      sessionId: 's1',
      tenantId: 't1',
      userId: 'u1',
    });
    expect(deps.tasks.failQueuedAttempt).not.toHaveBeenCalled();
    expect(inc).toHaveBeenCalledTimes(1);

    // 顺序必须是先预检、再建 run、最后入队：容量不足时不能落新行。
    expect(deps.queue.assertCapacity.mock.invocationCallOrder[0]).toBeLessThan(
      deps.tasks.createRetryRun.mock.invocationCallOrder[0]!,
    );
    expect(deps.tasks.createRetryRun.mock.invocationCallOrder[0]).toBeLessThan(
      deps.queue.submit.mock.invocationCallOrder[0]!,
    );
  });

  it('已取消的运行同样可重试', async () => {
    const { svc, deps } = makeService({ status: 'canceled' });

    await expect(svc.retry('r1', 't1', 'u1')).resolves.toEqual({
      runId: 'r2',
      taskId: 'task1',
      attempt: 2,
    });
    expect(deps.tasks.createRetryRun).toHaveBeenCalledTimes(1);
    expect(deps.tasks.createRetryRun.mock.calls[0][0]).toBe('task1');
  });

  it('queued/running/done 一律不可重试，且不产生任何副作用', async () => {
    for (const status of ['queued', 'running', 'done']) {
      const { svc, deps } = makeService({ status });
      await expect(svc.retry('r1', 't1', 'u1')).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.retry('r1', 't1', 'u1')).rejects.toThrow('run_not_retryable');
      expect(deps.queue.assertCapacity).not.toHaveBeenCalled();
      expect(deps.tasks.createRetryRun).not.toHaveBeenCalled();
      expect(deps.queue.submit).not.toHaveBeenCalled();
    }
  });

  it('run 不存在或非本人时 404 原样上抛', async () => {
    const { svc, deps } = makeService(new NotFoundException('run_not_found'));

    await expect(svc.retry('r1', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.queue.assertCapacity).not.toHaveBeenCalled();
    expect(deps.tasks.createRetryRun).not.toHaveBeenCalled();
  });

  it('createRetryRun 的冲突（并发/快照缺失）原样上抛，不入队', async () => {
    for (const code of ['task_busy', 'task_snapshot_missing']) {
      const { svc, deps } = makeService({ status: 'failed' });
      deps.tasks.createRetryRun.mockRejectedValue(new ConflictException(code));

      await expect(svc.retry('r1', 't1', 'u1')).rejects.toThrow(code);
      expect(deps.queue.submit).not.toHaveBeenCalled();
      expect(deps.tasks.failQueuedAttempt).not.toHaveBeenCalled();
    }
  });

  it('容量预检失败（队列已满）时不建 run', async () => {
    const { svc, deps } = makeService({ status: 'failed' });
    const full = new Error('queue_full');
    deps.queue.assertCapacity.mockRejectedValue(full);

    await expect(svc.retry('r1', 't1', 'u1')).rejects.toBe(full);
    expect(deps.tasks.createRetryRun).not.toHaveBeenCalled();
    expect(deps.queue.submit).not.toHaveBeenCalled();
  });

  it('入队失败时把新 run 标记 failed 并重新抛出原异常，且不计数', async () => {
    const { svc, deps, metrics } = makeService({ status: 'failed' });
    const inc = vi.spyOn(metrics.runsRetried, 'inc');
    const submitError = new Error('redis down');
    deps.queue.submit.mockRejectedValue(submitError);

    await expect(svc.retry('r1', 't1', 'u1')).rejects.toBe(submitError);
    expect(deps.tasks.failQueuedAttempt).toHaveBeenCalledWith('r2', 'task1');
    expect(inc).not.toHaveBeenCalled();
  });

  it('入队失败且回滚收尾也失败时，仍抛原始入队异常', async () => {
    const { svc, deps } = makeService({ status: 'failed' });
    const submitError = new Error('redis down');
    deps.queue.submit.mockRejectedValue(submitError);
    deps.tasks.failQueuedAttempt.mockRejectedValue(new Error('db down'));

    await expect(svc.retry('r1', 't1', 'u1')).rejects.toBe(submitError);
    expect(deps.tasks.failQueuedAttempt).toHaveBeenCalledTimes(1);
  });
});
