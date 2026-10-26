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
import type { RunControlBus, RunControlMessage } from './run-control-bus';
import { InsufficientCreditsError, PlanExpiredError } from '../billing/billing.errors';
import { createBffMetrics } from '../observability/observability.metrics';
import { encryptSecret } from '../secrets/secret-box';
import { MODEL_ENC_KEY } from '../models/model.constants';

const ENC_KEY_HEX = 'b'.repeat(64);
// 执行器下发 runtime 前需解密快照路由，提前提供合法密钥。
process.env.MODEL_ENC_KEY = ENC_KEY_HEX;

interface ExecutorDeps {
  fetch: ReturnType<typeof vi.fn>;
  tasks: {
    loadSnapshot: ReturnType<typeof vi.fn>;
    recordStep: ReturnType<typeof vi.fn>;
    bindModel: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    findRun: ReturnType<typeof vi.fn>;
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
  control: { subscribe: ReturnType<typeof vi.fn> };
  /** 控制总线退订函数，用于断言所有退出路径都只退订一次。 */
  off: ReturnType<typeof vi.fn>;
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

/**
 * 构造「建连成功但长流会挂起」的上游响应：先把 initial 事件入队，之后不再推进，
 * 直到取消信号把流置错——用于区分建连阶段与流式消费阶段的取消。
 */
function hangingSseResponse(
  initial: Array<{ event: string; data: unknown }>,
  signal: AbortSignal,
): Response {
  const body = initial.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        signal.addEventListener('abort', () =>
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      },
      // 不主动结束流：没有取消时应一直等待上游，模拟真实的长连接。
      pull: () => new Promise<void>(() => {}),
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** 直接 new 执行器并注入 mock 依赖；fetch 用 stubGlobal 接管。 */
function makeExecutor(): { executor: RunExecutor; deps: ExecutorDeps } {
  const off = vi.fn();
  const deps: ExecutorDeps = {
    fetch: vi.fn(),
    tasks: {
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
      recordStep: vi.fn().mockResolvedValue(undefined),
      bindModel: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
      findRun: vi
        .fn()
        .mockResolvedValue({ id: 'r1', status: 'running', lastError: null, cancelRequestedAt: null }),
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
    control: { subscribe: vi.fn().mockResolvedValue(off) },
    off,
  };
  vi.stubGlobal('fetch', deps.fetch);
  const executor = new RunExecutor(
    deps.tasks as unknown as TasksService,
    deps.attachments as unknown as AttachmentsService,
    deps.artifacts as unknown as ArtifactService,
    deps.billing as unknown as BillingService,
    deps.events as unknown as RunEventBus,
    deps.control as unknown as RunControlBus,
    createBffMetrics({ defaultMetrics: false }),
  );
  return { executor, deps };
}

function publishedEvents(deps: ExecutorDeps): string[] {
  return deps.events.publish.mock.calls.map((call) => (call[1] as { event: string }).event);
}

/** 取出最后一次发布的 error 负载，并校验 message 是前端可直接展示的非空字符串。 */
function lastErrorData(deps: ExecutorDeps): { message: string; error: string } {
  const calls = deps.events.publish.mock.calls;
  const msg = calls[calls.length - 1]?.[1] as { event: string; data: { message?: unknown; error?: string } };
  expect(msg.event).toBe('error');
  expect(typeof msg.data.message).toBe('string');
  expect((msg.data.message as string).length).toBeGreaterThan(0);
  return msg.data as { message: string; error: string };
}

beforeEach(() => {
  process.env.AGENT_RUNTIME_URL = 'http://runtime.test';
  delete process.env.AGENT_RUNTIME_TOKEN;
  process.env.MODEL_ENC_KEY = ENC_KEY_HEX;
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

  it('上游 5xx 时取消响应体、释放预占并标记 failed', async () => {
    const { executor, deps } = makeExecutor();
    const upstream = new Response('boom', { status: 502 });
    const cancel = vi.spyOn(upstream.body!, 'cancel');
    deps.fetch.mockResolvedValue(upstream);

    await executor.execute(job());

    expect(cancel).toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(deps.billing.recordUsage).not.toHaveBeenCalled();
    expect(deps.billing.settle).not.toHaveBeenCalled();
    expect(lastErrorData(deps)).toEqual({
      message: '模型服务返回错误，请稍后重试',
      error: 'upstream_error',
    });
  });

  it('上游 2xx 但无 body 时释放预占并标记 failed', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(new Response(null, { status: 200 }));

    await executor.execute(job());

    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(lastErrorData(deps)).toEqual({
      message: '模型服务返回空响应，请稍后重试',
      error: 'upstream_empty_body',
    });
  });

  it('beginRun 失败时直接收尾，不再请求上游', async () => {
    const { executor, deps } = makeExecutor();
    deps.billing.beginRun.mockRejectedValue(new InsufficientCreditsError());

    await executor.execute(job());

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(lastErrorData(deps)).toEqual({
      message: '积分不足，请充值后重试',
      error: 'insufficient_credits',
    });

    const second = makeExecutor();
    second.deps.billing.beginRun.mockRejectedValue(new PlanExpiredError());
    await second.executor.execute(job());
    expect(second.deps.fetch).not.toHaveBeenCalled();
    expect(lastErrorData(second.deps)).toEqual({
      message: '套餐已过期，请续费后重试',
      error: 'plan_expired',
    });
  });

  it('会话无模型时执行器回填模型，已有模型时跳过', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockResolvedValue({ ...snapshot(), model: null });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    expect(deps.billing.beginRun).toHaveBeenCalledWith('r1', 't1');
    expect(deps.tasks.bindModel).toHaveBeenCalledWith('s1', 'm1');

    const second = makeExecutor();
    second.deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));
    await second.executor.execute(job());
    expect(second.deps.tasks.bindModel).not.toHaveBeenCalled();
  });

  it('回填模型失败不影响执行', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockResolvedValue({ ...snapshot(), model: null });
    deps.tasks.bindModel.mockRejectedValue(new Error('db down'));
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.fetch).toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
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
    expect(lastErrorData(deps).error).toBe('run_failed');
  });

  it('残缺快照时不抛错：释放预占、标记 failed 并发布带 message 的 error', async () => {
    const { executor, deps } = makeExecutor();
    // 旧数据/异常写入可能只剩空对象，selectedModel 等字段全部缺失。
    deps.tasks.loadSnapshot.mockResolvedValue({});

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(publishedEvents(deps)).toEqual(['error']);
    expect(lastErrorData(deps)).toEqual({
      message: '本次运行失败，请稍后重试',
      error: 'run_failed',
    });
  });

  it('快照中的加密路由在请求体里以明文下发', async () => {
    const { executor, deps } = makeExecutor();
    const sealed = encryptSecret('sk-plain', MODEL_ENC_KEY);
    deps.tasks.loadSnapshot.mockResolvedValue({
      ...snapshot(),
      resolution: {
        selectedModel: 'm1',
        modelRoutes: [{ model: 'm1', baseUrl: 'https://ark.example/v3', apiKey: sealed }],
      },
    });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      modelRoutes: Array<{ apiKey: string }>;
    };
    expect(body.modelRoutes[0]!.apiKey).toBe('sk-plain');
    expect(body.modelRoutes[0]!.apiKey).not.toBe(sealed);
  });

  it('快照路由解密失败时释放预占、标记 failed 且不请求上游', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockResolvedValue({
      ...snapshot(),
      resolution: {
        selectedModel: 'm1',
        modelRoutes: [{ model: 'm1', baseUrl: 'https://ark.example/v3', apiKey: 'not-a-ciphertext' }],
      },
    });

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(publishedEvents(deps)).toEqual(['error']);
    expect(lastErrorData(deps).error).toBe('run_failed');
  });

  it('正常完成但无 usage 时释放预占且不结算', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.billing.recordUsage).not.toHaveBeenCalled();
    expect(deps.billing.settle).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', 'hi', 's1');
  });

  it('用量记录重试全部失败时释放预占且不结算', async () => {
    const { executor, deps } = makeExecutor();
    deps.billing.recordUsage.mockRejectedValue(new Error('db down'));
    deps.fetch.mockResolvedValue(
      sseResponse([
        {
          event: 'usage',
          data: { input: 3, output: 2, models: [{ model: 'm1', input: 3, output: 2 }] },
        },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.billing.recordUsage).toHaveBeenCalledTimes(3);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.billing.settle).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
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
    expect(lastErrorData(deps)).toEqual({
      message: '本次运行失败，请稍后重试',
      error: 'run_failed',
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

  it('收到 cancel 控制消息后中止上游，标记 canceled 并发布终止状态', async () => {
    const { executor, deps } = makeExecutor();
    let handler: ((msg: RunControlMessage) => void) | undefined;
    deps.control.subscribe.mockImplementation(async (_runId: string, h: typeof handler) => {
      handler = h;
      return deps.off;
    });

    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    deps.fetch.mockImplementation((_url: unknown, init: { signal: AbortSignal }) => {
      fetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortErr));
      });
    });

    const running = executor.execute(job());
    await started;
    expect(handler).toBeTypeOf('function');
    handler!({ type: 'cancel' });
    await expect(running).resolves.toBeUndefined();

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(deps.billing.recordUsage).not.toHaveBeenCalled();
    expect(deps.billing.settle).not.toHaveBeenCalled();
    expect(publishedEvents(deps)).toEqual(['status']);
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'status',
      data: { runId: 'r1', status: 'canceled' },
    });
    expect(deps.off).toHaveBeenCalledTimes(1);
  });

  it('流式消费阶段收到 cancel：中止上游、标记 canceled，无用量则不结算', async () => {
    const { executor, deps } = makeExecutor();
    let handler: ((msg: RunControlMessage) => void) | undefined;
    deps.control.subscribe.mockImplementation(async (_runId: string, h: typeof handler) => {
      handler = h;
      return deps.off;
    });
    let stepConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => {
      stepConsumed = resolve;
    });
    // recordStep 落定说明首个 chunk 已被消费：此时取消属于流式阶段，而非建连阶段。
    deps.tasks.recordStep.mockImplementation(async () => stepConsumed());
    deps.fetch.mockImplementation((_url: unknown, init: { signal: AbortSignal }) =>
      Promise.resolve(
        hangingSseResponse(
          [{ event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) }],
          init.signal,
        ),
      ),
    );

    const running = executor.execute(job());
    await consumed;
    handler!({ type: 'cancel' });
    await expect(running).resolves.toBeUndefined();

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.billing.recordUsage).not.toHaveBeenCalled();
    expect(deps.billing.settle).not.toHaveBeenCalled();
    // 取消不保留半截回答，assistantText 必须为空。
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'status',
      data: { runId: 'r1', status: 'canceled' },
    });
    expect(publishedEvents(deps)[publishedEvents(deps).length - 1]).toBe('status');
    expect(deps.off).toHaveBeenCalledTimes(1);
  });

  it('confirm 控制消息转发到 runtime HTTP 端点', async () => {
    // runtime 的待确认 promise 在它自己的进程内，只有持有该连接的执行器能送达决策。
    process.env.AGENT_RUNTIME_TOKEN = 'rt';
    const { executor, deps } = makeExecutor();
    let handler: ((msg: RunControlMessage) => void) | undefined;
    deps.control.subscribe.mockImplementation(async (_runId: string, h: typeof handler) => {
      handler = h;
      return deps.off;
    });
    let stepConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => {
      stepConsumed = resolve;
    });
    deps.tasks.recordStep.mockImplementation(async () => stepConsumed());
    deps.fetch.mockImplementation((url: unknown, init: { signal: AbortSignal }) => {
      if (String(url) === 'http://runtime.test/runs/r1/confirm') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        hangingSseResponse(
          [{ event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) }],
          init.signal,
        ),
      );
    });

    const running = executor.execute(job());
    await consumed;
    handler!({ type: 'confirm', confirmId: 'c1', approved: false });

    await vi.waitFor(() => {
      const call = deps.fetch.mock.calls.find(
        ([url]) => String(url) === 'http://runtime.test/runs/r1/confirm',
      );
      expect(call).toBeDefined();
      const init = call![1] as {
        method: string;
        headers: Record<string, string>;
        body: string;
      };
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['x-agent-runtime-token']).toBe('rt');
      expect(JSON.parse(init.body)).toEqual({ confirmId: 'c1', approved: false });
    });

    // 转发后仍可正常取消收尾，确保没有悬挂的执行 promise。
    handler!({ type: 'cancel' });
    await expect(running).resolves.toBeUndefined();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
  });

  it('已收到 usage 后取消：仍记录用量并结算，finish 为 canceled 且不保留半截回答', async () => {
    const { executor, deps } = makeExecutor();
    let handler: ((msg: RunControlMessage) => void) | undefined;
    deps.control.subscribe.mockImplementation(async (_runId: string, h: typeof handler) => {
      handler = h;
      return deps.off;
    });
    let stepConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => {
      stepConsumed = resolve;
    });
    deps.tasks.recordStep.mockImplementation(async () => stepConsumed());
    const usage = { input: 10, output: 5, models: [{ model: 'm1', input: 10, output: 5 }] };
    deps.fetch.mockImplementation((_url: unknown, init: { signal: AbortSignal }) =>
      Promise.resolve(
        hangingSseResponse(
          [
            { event: 'usage', data: usage },
            { event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) },
          ],
          init.signal,
        ),
      ),
    );

    const running = executor.execute(job());
    await consumed;
    handler!({ type: 'cancel' });
    await expect(running).resolves.toBeUndefined();

    expect(deps.billing.recordUsage).toHaveBeenCalledWith(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      usage,
    );
    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.billing.releaseHold).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'status',
      data: { runId: 'r1', status: 'canceled' },
    });
  });

  it('执行前已有 cancelRequestedAt 时跳过上游并释放预占', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.findRun.mockResolvedValue({
      id: 'r1',
      status: 'running',
      lastError: null,
      cancelRequestedAt: new Date(),
    });

    await executor.execute(job());

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(publishedEvents(deps)).toEqual(['status']);
    expect(deps.off).toHaveBeenCalledTimes(1);
  });

  it('成功与失败路径都只退订一次取消订阅', async () => {
    const ok = makeExecutor();
    ok.deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));
    await ok.executor.execute(job());
    expect(ok.deps.off).toHaveBeenCalledTimes(1);

    const failed = makeExecutor();
    failed.deps.billing.beginRun.mockRejectedValue(new InsufficientCreditsError());
    await failed.executor.execute(job());
    expect(failed.deps.off).toHaveBeenCalledTimes(1);
  });

  it('取消订阅失败只记日志，运行继续', async () => {
    const { executor, deps } = makeExecutor();
    deps.control.subscribe.mockRejectedValue(new Error('redis down'));
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
  });
});
