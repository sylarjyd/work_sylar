import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { RunsService } from './runs.service';
import type { TasksService } from '../tasks/tasks.service';
import type { RunQueueService } from '../queue/run-queue.service';
import type { RunControlBus } from '../queue/run-control-bus';
import type { RunEventBus } from '../queue/run-event-bus';

interface Deps {
  tasks: {
    findOwnedRun: ReturnType<typeof vi.fn>;
    markCanceled: ReturnType<typeof vi.fn>;
    markCancelRequested: ReturnType<typeof vi.fn>;
  };
  queue: { remove: ReturnType<typeof vi.fn> };
  control: { publish: ReturnType<typeof vi.fn> };
  events: { publish: ReturnType<typeof vi.fn> };
}

/** 按给定 run 状态构造服务；findOwnedRun 默认返回本人 r1/task1。 */
function makeService(
  run: { status: string; cancelRequestedAt?: Date | null } | Error,
): { svc: RunsService; deps: Deps } {
  const deps: Deps = {
    tasks: {
      findOwnedRun: vi.fn(),
      markCanceled: vi.fn().mockResolvedValue(true),
      markCancelRequested: vi.fn().mockResolvedValue(undefined),
    },
    queue: { remove: vi.fn().mockResolvedValue(true) },
    control: { publish: vi.fn().mockResolvedValue(undefined) },
    events: { publish: vi.fn().mockResolvedValue(undefined) },
  };
  if (run instanceof Error) {
    deps.tasks.findOwnedRun.mockRejectedValue(run);
  } else {
    deps.tasks.findOwnedRun.mockResolvedValue({
      id: 'r1',
      taskId: 'task1',
      status: run.status,
      cancelRequestedAt: run.cancelRequestedAt ?? null,
    });
  }
  const svc = new RunsService(
    deps.tasks as unknown as TasksService,
    deps.queue as unknown as RunQueueService,
    deps.control as unknown as RunControlBus,
    deps.events as unknown as RunEventBus,
  );
  return { svc, deps };
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

  it('排队作业已被 worker 取走（remove=false）时降级为控制消息', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    deps.queue.remove.mockResolvedValue(false);

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'running' });
    expect(deps.tasks.markCanceled).not.toHaveBeenCalled();
    expect(deps.tasks.markCancelRequested).toHaveBeenCalledWith('r1');
    expect(deps.control.publish).toHaveBeenCalledWith('r1', { type: 'cancel' });
  });

  it('remove 成功后 run 已被执行器抢占（markCanceled=false）时返回 running', async () => {
    const { svc, deps } = makeService({ status: 'queued' });
    deps.tasks.markCanceled.mockResolvedValue(false);

    await expect(svc.cancel('r1', 't1', 'u1')).resolves.toEqual({ status: 'running' });
    expect(deps.events.publish).not.toHaveBeenCalled();
    // 已由 worker 持有，控制消息必须由执行器路径补发。
    expect(deps.tasks.markCancelRequested).not.toHaveBeenCalled();
    expect(deps.control.publish).not.toHaveBeenCalled();
  });
});
