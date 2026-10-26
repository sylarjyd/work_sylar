import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { TasksService } from '../tasks/tasks.service';
import type { QueueRuntimeConfig } from './queue.config';
import type { RunQueue } from './queue.tokens';
import type { RunControlBus } from './run-control-bus';
import { RECOVERY_INTERVAL_MS, RunRecoveryService } from './run-recovery.service';

interface RunRef {
  id: string;
  taskId: string;
  sessionId: string;
  startedAt: Date;
}

function staleRun(id = 'r1'): RunRef {
  return {
    id,
    taskId: `task-${id}`,
    sessionId: `s-${id}`,
    startedAt: new Date('2026-10-26T00:00:00Z'),
  };
}

interface Options {
  enabled?: boolean;
  queue?: RunQueue | null;
  runs?: RunRef[];
  cancels?: { id: string }[];
}

/** 直接 new 服务并注入桩；恢复逻辑不依赖真实 Redis 与 Nest 容器。 */
function makeService(options: Options = {}) {
  const enabled = options.enabled ?? true;
  const config: QueueRuntimeConfig = {
    enabled,
    name: 'runs',
    concurrency: 1,
    redisUrl: enabled ? 'redis://x' : null,
  };
  const queue = (options.queue === undefined
    ? { getJob: vi.fn().mockResolvedValue(undefined) }
    : options.queue) as RunQueue | null;
  const tasks = {
    listStaleRunningRuns: vi.fn().mockResolvedValue(options.runs ?? []),
    listStaleCancelRequests: vi.fn().mockResolvedValue(options.cancels ?? []),
    failStaleRun: vi.fn().mockResolvedValue(true),
  };
  const billing = { releaseHold: vi.fn().mockResolvedValue(undefined) };
  const control = { publish: vi.fn().mockResolvedValue(undefined) };
  const svc = new RunRecoveryService(
    config,
    queue,
    tasks as unknown as TasksService,
    billing as unknown as BillingService,
    control as unknown as RunControlBus,
  );
  return { svc, queue, tasks, billing, control };
}

function jobWithState(state: string) {
  return { getState: vi.fn().mockResolvedValue(state) };
}

/** 用给定 getJob 行为构造队列桩。 */
function queueWith(getJob: ReturnType<typeof vi.fn>): RunQueue {
  return { getJob } as unknown as RunQueue;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RunRecoveryService', () => {
  it('未启用队列时不查询任何数据，也不启动定时器', async () => {
    const disabled = makeService({ enabled: false, runs: [staleRun()] });
    disabled.svc.onApplicationBootstrap();
    await disabled.svc.recover();
    expect(disabled.tasks.listStaleRunningRuns).not.toHaveBeenCalled();
    expect(disabled.tasks.listStaleCancelRequests).not.toHaveBeenCalled();

    const noQueue = makeService({ queue: null, runs: [staleRun()] });
    noQueue.svc.onApplicationBootstrap();
    await noQueue.svc.recover();
    expect(noQueue.tasks.listStaleRunningRuns).not.toHaveBeenCalled();
    expect(noQueue.tasks.listStaleCancelRequests).not.toHaveBeenCalled();
  });

  it('作业仍可投递（waiting/delayed/active/...）时不收尾', async () => {
    for (const state of ['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']) {
      const { svc, tasks, billing } = makeService({
        queue: queueWith(vi.fn().mockResolvedValue(jobWithState(state))),
        runs: [staleRun()],
      });

      await svc.recover();

      expect(billing.releaseHold).not.toHaveBeenCalled();
      expect(tasks.failStaleRun).not.toHaveBeenCalled();
    }
  });

  it('作业不存在时先释放预占，再以 worker_lost 收尾，并按 10 分钟阈值查询', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const { svc, tasks, billing } = makeService({
      queue: queueWith(vi.fn().mockResolvedValue(undefined)),
      runs: [staleRun('r1')],
    });

    await svc.recover(now);

    expect(tasks.listStaleRunningRuns).toHaveBeenCalledWith(
      new Date('2026-10-26T11:50:00Z'),
    );
    expect(billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(tasks.failStaleRun).toHaveBeenCalledWith('r1', 'task-r1', 'worker_lost');
    // 先释放预占、后落库状态：即使状态收尾失败，额度也不会被永久占用。
    expect(billing.releaseHold.mock.invocationCallOrder[0]).toBeLessThan(
      tasks.failStaleRun.mock.invocationCallOrder[0]!,
    );
  });

  it('作业已 completed/failed 时视为丢失并收尾', async () => {
    for (const state of ['completed', 'failed']) {
      const { svc, tasks, billing } = makeService({
        queue: queueWith(vi.fn().mockResolvedValue(jobWithState(state))),
        runs: [staleRun('r1')],
      });

      await svc.recover();

      expect(billing.releaseHold).toHaveBeenCalledWith('r1');
      expect(tasks.failStaleRun).toHaveBeenCalledWith('r1', 'task-r1', 'worker_lost');
    }
  });

  it('getJob 抛错（Redis 不可用）时跳过该运行，并继续处理其余行', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const getJob = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);
    const { svc, tasks, billing } = makeService({
      queue: queueWith(getJob),
      runs: [staleRun('r1'), staleRun('r2')],
    });

    await svc.recover();

    // Redis 不可用时不能把 run 误判为失联；但扫描要继续处理下一行。
    expect(billing.releaseHold).toHaveBeenCalledTimes(1);
    expect(billing.releaseHold).toHaveBeenCalledWith('r2');
    expect(tasks.failStaleRun).toHaveBeenCalledTimes(1);
    expect(tasks.failStaleRun).toHaveBeenCalledWith('r2', 'task-r2', 'worker_lost');
    expect(warn).toHaveBeenCalled();
  });

  it('单条回收抛错不影响其余运行', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, tasks, billing } = makeService({
      queue: queueWith(vi.fn().mockResolvedValue(undefined)),
      runs: [staleRun('r1'), staleRun('r2')],
    });
    billing.releaseHold.mockRejectedValueOnce(new Error('billing down'));

    await svc.recover();

    // r1 释放预占失败：不能继续收尾 r1，但必须继续处理 r2。
    expect(billing.releaseHold).toHaveBeenCalledTimes(2);
    expect(tasks.failStaleRun).toHaveBeenCalledTimes(1);
    expect(tasks.failStaleRun).toHaveBeenCalledWith('r2', 'task-r2', 'worker_lost');
  });

  it('陈旧的取消请求逐条重发 cancel，单条失败不影响其余', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const now = new Date('2026-10-26T12:00:00Z');
    const { svc, tasks, control } = makeService({ cancels: [{ id: 'r1' }, { id: 'r2' }] });
    control.publish.mockRejectedValueOnce(new Error('redis down'));

    await svc.recover(now);

    expect(tasks.listStaleCancelRequests).toHaveBeenCalledWith(
      new Date('2026-10-26T11:58:00Z'),
    );
    expect(control.publish).toHaveBeenCalledTimes(2);
    expect(control.publish).toHaveBeenNthCalledWith(1, 'r1', { type: 'cancel' });
    expect(control.publish).toHaveBeenNthCalledWith(2, 'r2', { type: 'cancel' });
    expect(warn).toHaveBeenCalled();
  });

  it('启动后立即恢复一次、周期执行，关闭时清理定时器', async () => {
    vi.useFakeTimers();
    const { svc } = makeService({ runs: [] });
    const recover = vi.spyOn(svc, 'recover').mockResolvedValue(undefined);

    svc.onApplicationBootstrap();
    expect(recover).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS);
    expect(recover).toHaveBeenCalledTimes(2);

    svc.onApplicationShutdown();
    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS * 3);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('顶层查询失败时吞掉异常并记录，不产生未处理的 rejection', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, tasks, control } = makeService();
    tasks.listStaleRunningRuns.mockRejectedValue(new Error('db down'));

    await expect(svc.recover()).resolves.toBeUndefined();

    // 启动与定时器都不接 Promise：失败必须在本轮内部消化，等下一轮重试。
    expect(error).toHaveBeenCalled();
    expect(tasks.listStaleCancelRequests).not.toHaveBeenCalled();
    expect(control.publish).not.toHaveBeenCalled();

    // in-flight 标志必须复位，否则下一轮永远不会再扫描。
    tasks.listStaleRunningRuns.mockResolvedValue([]);
    await svc.recover();
    expect(tasks.listStaleRunningRuns).toHaveBeenCalledTimes(2);
  });

  it('上一轮未完成时跳过重入的恢复扫描', async () => {
    const { svc, tasks } = makeService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tasks.listStaleRunningRuns.mockImplementation(async () => {
      await gate;
      return [];
    });

    const first = svc.recover();
    const second = svc.recover();
    release();
    await Promise.all([first, second]);

    // 第二轮看到 in-flight 标志直接返回，不重复扫描。
    expect(tasks.listStaleRunningRuns).toHaveBeenCalledTimes(1);
  });
});
