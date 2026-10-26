import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBffMetrics } from '../observability/observability.metrics';
import type { SettingsService } from '../settings/settings.service';
import type { TasksService } from '../tasks/tasks.service';
import type { QueueRuntimeConfig } from './queue.config';
import type { RunExecutor } from './run-executor.service';
import type { RunJob } from './run-job';
import { RunWorker, WORKER_CLOSE_TIMEOUT_MS } from './run-worker';

interface MockWorker {
  close: ReturnType<typeof vi.fn>;
  backend: { disconnect: ReturnType<typeof vi.fn> };
}

function makeWorker(closeImpl: () => Promise<void>): MockWorker {
  return {
    close: vi.fn(closeImpl),
    backend: { disconnect: vi.fn().mockResolvedValue(undefined) },
  };
}

/** 直接 new 服务并注入桩 worker；关闭逻辑不依赖真实 Redis 与 Nest 容器。 */
function makeService(worker: MockWorker): RunWorker {
  const config: QueueRuntimeConfig = {
    enabled: true,
    name: 'runs',
    concurrency: 1,
    redisUrl: 'redis://x',
  };
  const service = new RunWorker(
    config,
    null,
    null,
    { execute: vi.fn() } as unknown as RunExecutor,
    { countRunning: vi.fn() } as unknown as TasksService,
    { getQueueConfig: vi.fn() } as unknown as SettingsService,
    createBffMetrics({ defaultMetrics: false }),
  );
  // 绕过 bootstrap 直接挂桩，close() 只关心已创建的 worker 实例。
  (service as unknown as { worker: Worker<RunJob, void, 'run'> | null }).worker =
    worker as unknown as Worker<RunJob, void, 'run'>;
  return service;
}

describe('RunWorker.close', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('正常关闭时不传 force，也不断开后端连接', async () => {
    const worker = makeWorker(() => Promise.resolve());
    const service = makeService(worker);

    await service.close();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledWith();
    expect(worker.backend.disconnect).not.toHaveBeenCalled();
  });

  it('关闭超时后强制断开后端连接并记录告警', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // close 永不 resolve，模拟在途作业长时间不结束。
    const worker = makeWorker(() => new Promise<void>(() => undefined));
    const service = makeService(worker);

    const closing = service.close();
    await vi.advanceTimersByTimeAsync(WORKER_CLOSE_TIMEOUT_MS);
    await closing;

    // BullMQ 的 close 幂等，二次 close(true) 无效，必须直接断开 backend。
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.backend.disconnect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('worker 关闭超时，强制断开连接');
  });

  it('重复 close 幂等，不会重复断开连接', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const worker = makeWorker(() => new Promise<void>(() => undefined));
    const service = makeService(worker);

    const closing = service.close();
    await vi.advanceTimersByTimeAsync(WORKER_CLOSE_TIMEOUT_MS);
    await closing;

    await expect(service.close()).resolves.toBeUndefined();
    expect(worker.backend.disconnect).toHaveBeenCalledTimes(1);
  });
});
