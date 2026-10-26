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
  return { service, queue, executor, metrics };
}

describe('RunQueueService', () => {
  it('排队超限抛 QueueFullError', async () => {
    const { service, queue } = makeService({ queuedCount: 50 });

    await expect(service.enqueue(job())).rejects.toBeInstanceOf(QueueFullError);
    expect(queue!.add).not.toHaveBeenCalled();
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
    const depth = await metrics.runQueueDepth.get();
    expect(enqueued.values[0]!.value).toBe(1);
    expect(depth.values[0]!.value).toBe(1);
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
