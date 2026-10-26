import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { RunExecutor } from './run-executor.service';
import type { RunJob, RunSnapshot } from './run-job';
import type { TasksService } from '../tasks/tasks.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { ArtifactService } from '../artifacts/artifacts.service';
import type { BillingService } from '../billing/billing.service';
import type { RunEventBus } from './run-event-bus';
import { InsufficientCreditsError, PlanExpiredError } from '../billing/billing.errors';
import { createBffMetrics } from '../observability/observability.metrics';

interface ExecutorDeps {
  fetch: ReturnType<typeof vi.fn>;
  tasks: {
    loadSnapshot: ReturnType<typeof vi.fn>;
    recordStep: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
  };
  attachments: { hydrateForRun: ReturnType<typeof vi.fn> };
  artifacts: { record: ReturnType<typeof vi.fn> };
  billing: {
    beginRun: ReturnType<typeof vi.fn>;
    recordUsage: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    releaseHold: ReturnType<typeof vi.fn>;
  };
  events: { publish: ReturnType<typeof vi.fn> };
}

function snapshot(): RunSnapshot {
  return {
    goal: '写个总结',
    messages: [{ role: 'user', content: '写个总结', attachments: [] }],
    model: 'm1',
    resolution: { selectedModel: 'm1', modelRoutes: [] },
    config: { maxRounds: 3, confirmTimeoutMs: 1000, codeExecTimeoutMs: 5000 },
    traceId: null,
    assistant: null,
  };
}

function job(): RunJob {
  return { runId: 'r1', taskId: 't1', sessionId: 's1', tenantId: 't1', userId: 'u1' };
}

function stepEvent(seq: number, type: string, payload: Record<string, unknown>) {
  return { runId: 'r1', seq, type, payload, ts: seq };
}

/** 把事件列表编码成一个完整的 SSE 响应体。 */
function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 直接 new 执行器并注入 mock 依赖；fetch 用 stubGlobal 接管。 */
function makeExecutor(): { executor: RunExecutor; deps: ExecutorDeps } {
  const deps: ExecutorDeps = {
    fetch: vi.fn(),
    tasks: {
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
      recordStep: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    },
    attachments: {
      hydrateForRun: vi.fn().mockImplementation(async (messages: unknown) => messages),
    },
    artifacts: { record: vi.fn().mockResolvedValue(undefined) },
    billing: {
      beginRun: vi.fn().mockResolvedValue({
        maxCredits: 50,
        allowedModels: ['m1'],
        prices: {},
      }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      settle: vi.fn().mockResolvedValue(undefined),
      releaseHold: vi.fn().mockResolvedValue(undefined),
    },
    events: { publish: vi.fn().mockResolvedValue(undefined) },
  };
  vi.stubGlobal('fetch', deps.fetch);
  const executor = new RunExecutor(
    deps.tasks as unknown as TasksService,
    deps.attachments as unknown as AttachmentsService,
    deps.artifacts as unknown as ArtifactService,
    deps.billing as unknown as BillingService,
    deps.events as unknown as RunEventBus,
    createBffMetrics({ defaultMetrics: false }),
  );
  return { executor, deps };
}

function publishedEvents(deps: ExecutorDeps): string[] {
  return deps.events.publish.mock.calls.map((call) => (call[1] as { event: string }).event);
}

beforeEach(() => {
  process.env.AGENT_RUNTIME_URL = 'http://runtime.test';
  delete process.env.AGENT_RUNTIME_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunExecutor', () => {
  it('execute 逐条落 step、记录 usage 并结算', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        {
          event: 'step',
          data: stepEvent(1, 'artifact', {
            kind: 'pptx',
            filename: 'a.pptx',
            storageKey: 'artifacts/t1/r1/x-a.pptx',
            size: 3,
          }),
        },
        {
          event: 'usage',
          data: { input: 10, output: 5, models: [{ model: 'm1', input: 10, output: 5 }] },
        },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.billing.beginRun).toHaveBeenCalledWith('r1', 't1');
    expect(deps.tasks.recordStep).toHaveBeenCalledTimes(2);
    expect(deps.artifacts.record).toHaveBeenCalledWith(
      'r1',
      's1',
      't1',
      expect.objectContaining({ filename: 'a.pptx' }),
    );
    expect(deps.billing.recordUsage).toHaveBeenCalledWith(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      { input: 10, output: 5, models: [{ model: 'm1', input: 10, output: 5 }] },
    );
    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.billing.releaseHold).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', 'hi', 's1');
    // 事件总线收到逐条 step 与终止 done，供 SSE 转发器消费。
    expect(publishedEvents(deps)).toEqual(['step', 'step', 'done']);
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'done',
      data: { runId: 'r1' },
    });
  });

  it('上游 5xx 时释放预占并标记 failed', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(new Response('boom', { status: 502 }));

    await executor.execute(job());

    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(deps.billing.recordUsage).not.toHaveBeenCalled();
    expect(deps.billing.settle).not.toHaveBeenCalled();
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'error',
      data: { error: 'upstream_error' },
    });
  });

  it('上游 2xx 但无 body 时释放预占并标记 failed', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(new Response(null, { status: 200 }));

    await executor.execute(job());

    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'error',
      data: { error: 'upstream_empty_body' },
    });
  });

  it('beginRun 失败时直接收尾，不再请求上游', async () => {
    const { executor, deps } = makeExecutor();
    deps.billing.beginRun.mockRejectedValue(new InsufficientCreditsError());

    await executor.execute(job());

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'error',
      data: { error: 'insufficient_credits' },
    });

    const second = makeExecutor();
    second.deps.billing.beginRun.mockRejectedValue(new PlanExpiredError());
    await second.executor.execute(job());
    expect(second.deps.fetch).not.toHaveBeenCalled();
    expect(second.deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'error',
      data: { error: 'plan_expired' },
    });
  });

  it('附件 hydrate 失败时释放预占、标记 failed 并发布 error', async () => {
    const { executor, deps } = makeExecutor();
    deps.attachments.hydrateForRun.mockRejectedValue(new Error('storage down'));

    await executor.execute(job());

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(publishedEvents(deps)).toEqual(['error']);
  });

  it('快照缺失时释放预占、标记 failed 并发布 error', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockRejectedValue(new NotFoundException('task_snapshot_missing'));

    await executor.execute(job());

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(publishedEvents(deps)).toEqual(['error']);
  });

  it('上游发 error 事件时记为 failed，但已收到的 usage 仍结算', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(
      sseResponse([
        {
          event: 'usage',
          data: { input: 1, output: 1, models: [{ model: 'm1', input: 1, output: 1 }] },
        },
        { event: 'error', data: { message: 'boom' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'error',
      data: { error: 'run_failed' },
    });
  });

  it('事件发布失败不影响结算与 finish', async () => {
    const { executor, deps } = makeExecutor();
    deps.events.publish.mockRejectedValue(new Error('redis down'));
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        {
          event: 'usage',
          data: { input: 2, output: 1, models: [{ model: 'm1', input: 2, output: 1 }] },
        },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', 'hi', 's1');
  });
});
