import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactService } from '../artifacts/artifacts.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { BillingService } from '../billing/billing.service';
import { createBffMetrics } from '../observability/observability.metrics';
import type { SettingsService } from '../settings/settings.service';
import type { TasksService } from '../tasks/tasks.service';
import type { QueueRuntimeConfig } from './queue.config';
import type { RunQueue } from './queue.tokens';
import type { RunEventBus } from './run-event-bus';
import { RunExecutor } from './run-executor.service';
import type { RunJob } from './run-job';
import { QueueFullError, RunQueueService } from './run-queue.service';

function job(): RunJob {
  return { runId: 'r1', taskId: 't1', sessionId: 's1', tenantId: 't1', userId: 'u1' };
}

function makeQueue(): RunQueue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'r1' }),
    getJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as RunQueue;
}

interface ServiceOptions {
  enabled?: boolean;
  queue?: RunQueue | null;
  queuedCount?: number;
  maxPerTenant?: number;
}

/** 直接 new 服务并注入桩；队列能力用最小 mock 表示，避免测试依赖 Redis。 */
function makeService(options: ServiceOptions = {}): {
  service: RunQueueService;
  queue: RunQueue | null;
  executor: { execute: ReturnType<typeof vi.fn> };
  tasks: { countQueued: ReturnType<typeof vi.fn> };
  metrics: ReturnType<typeof createBffMetrics>;
} {
  const enabled = options.enabled ?? true;
  const config: QueueRuntimeConfig = {
    enabled,
    name: 'runs',
    concurrency: 4,
    redisUrl: enabled ? 'redis://x' : null,
  };
  const queue = options.queue === undefined ? makeQueue() : options.queue;
  const executor = { execute: vi.fn().mockResolvedValue(undefined) };
  const tasks = { countQueued: vi.fn().mockResolvedValue(options.queuedCount ?? 0) };
  const settings = {
    getQueueConfig: vi.fn().mockResolvedValue({
      maxAttempts: 2,
      perTenantConcurrency: 2,
      maxPerTenant: options.maxPerTenant ?? 50,
    }),
  };
  const metrics = createBffMetrics({ defaultMetrics: false });
  const service = new RunQueueService(
    config,
    queue,
    executor as unknown as RunExecutor,
    tasks as unknown as TasksService,
    settings as unknown as SettingsService,
    metrics,
  );
  return { service, queue, executor, tasks, metrics };
}

describe('RunQueueService', () => {
  it('排队超限抛 QueueFullError', async () => {
    const { service, queue } = makeService({ queuedCount: 50 });

    await expect(service.enqueue(job())).rejects.toBeInstanceOf(QueueFullError);
    expect(queue!.add).not.toHaveBeenCalled();
  });

  it('入队时按 (租户, 当前任务) 统计排队数，排除新任务自身', async () => {
    const { service, tasks } = makeService();

    await service.enqueue({ runId: 'r9', taskId: 'task-9', sessionId: 's9', tenantId: 'tenant-9', userId: 'u9' });

    expect(tasks.countQueued).toHaveBeenCalledWith('tenant-9', 'task-9');
  });

  it('排除自身后未达上限仍可入队', async () => {
    // 新任务已落库为 queued，countQueued 返回的是排除自身后的其他人数量 0。
    const { service, queue } = makeService({ maxPerTenant: 1, queuedCount: 0 });

    await service.enqueue(job());

    expect(queue!.add).toHaveBeenCalledTimes(1);
  });

  it('maxPerTenant 为 1 且已有他人任务排队时抛 QueueFullError', async () => {
    const { service, queue } = makeService({ maxPerTenant: 1, queuedCount: 1 });

    await expect(service.enqueue(job())).rejects.toBeInstanceOf(QueueFullError);
    expect(queue!.add).not.toHaveBeenCalled();
  });

  it('assertCapacity 达到上限时抛 QueueFullError', async () => {
    const { service, tasks } = makeService({ queuedCount: 50 });
    await expect(service.assertCapacity('t1')).rejects.toBeInstanceOf(QueueFullError);
    // 建单前预检：不排除任何任务，统计当前全部排队数。
    expect(tasks.countQueued).toHaveBeenCalledWith('t1');
  });

  it('assertCapacity 未达上限时直接通过', async () => {
    const { service } = makeService({ queuedCount: 49, maxPerTenant: 50 });
    await expect(service.assertCapacity('t1')).resolves.toBeUndefined();
  });

  it('assertCapacity 在队列禁用时直接返回且不读配置/不统计', async () => {
    const { service, tasks } = makeService({ enabled: false, queue: null });
    await expect(service.assertCapacity('t1')).resolves.toBeUndefined();
    expect(tasks.countQueued).not.toHaveBeenCalled();
  });

  it('无 queue 时 submit 走内联并调用 executor.execute', async () => {
    const { service, executor } = makeService({ enabled: false, queue: null });

    await expect(service.submit(job())).resolves.toBe('inline');
    expect(executor.execute).toHaveBeenCalledWith(job());
  });

  it('内联执行失败时 submit 不抛出', async () => {
    const { service, executor } = makeService({ enabled: false, queue: null });
    executor.execute.mockRejectedValue(new Error('boom'));

    await expect(service.submit(job())).resolves.toBe('inline');
  });

  it('enqueue 成功调用 queue.add 并累加指标', async () => {
    const { service, queue, metrics } = makeService();

    await service.enqueue(job());

    expect(queue!.add).toHaveBeenCalledWith('run', job(), {
      jobId: 'r1',
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    const enqueued = await metrics.runsEnqueued.get();
    expect(enqueued.values[0]!.value).toBe(1);
    // 深度改为 worker 周期对账，入队路径不再自增。
    const depth = await metrics.runQueueDepth.get();
    expect(depth.values[0]?.value ?? 0).toBe(0);
  });

  it('同一 runId 已有 waiting 作业时不重复入队也不累加指标', async () => {
    const queue = makeQueue();
    (queue.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      getState: vi.fn().mockResolvedValue('waiting'),
      remove: vi.fn(),
    });
    const { service, metrics } = makeService({ queue });

    await service.enqueue(job());

    expect(queue.add).not.toHaveBeenCalled();
    const enqueued = await metrics.runsEnqueued.get();
    expect(enqueued.values[0]?.value ?? 0).toBe(0);
  });

  it('同一 runId 的已完成作业先移除再重新入队', async () => {
    const queue = makeQueue();
    const remove = vi.fn().mockResolvedValue(undefined);
    (queue.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      remove,
    });
    const { service, metrics } = makeService({ queue });

    await service.enqueue(job());

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const enqueued = await metrics.runsEnqueued.get();
    expect(enqueued.values[0]!.value).toBe(1);
  });

  it('启用队列时 submit 入队并返回 queued', async () => {
    const { service, queue, executor } = makeService();

    await expect(service.submit(job())).resolves.toBe('queued');
    expect(queue!.add).toHaveBeenCalledTimes(1);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('无 queue 时 enqueue 抛 queue_disabled', async () => {
    const { service } = makeService({ enabled: false, queue: null });

    await expect(service.enqueue(job())).rejects.toThrow('queue_disabled');
  });

  it('remove 在无队列时返回 false', async () => {
    const { service } = makeService({ enabled: false, queue: null });
    await expect(service.remove('r1')).resolves.toBe(false);
  });

  it('remove 在作业不存在时视为成功', async () => {
    const { service } = makeService();
    await expect(service.remove('r1')).resolves.toBe(true);
  });

  it('remove 删除后复查作业已不存在才返回 true', async () => {
    const queue = makeQueue();
    const remove = vi.fn().mockResolvedValue(undefined);
    (queue.getJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ remove })
      .mockResolvedValueOnce(undefined);
    const { service } = makeService({ queue });

    await expect(service.remove('r1')).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
