import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import type { RunCheckpointEvent } from '@ai-office/shared';
import { RunExecutor, parseCheckpoint } from './run-executor.service';
import { SESSION_MODE_PROMPTS, type RunJob, type RunSnapshot } from './run-job';
import type { TasksService } from '../tasks/tasks.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { ArtifactService } from '../artifacts/artifacts.service';
import { BillingService } from '../billing/billing.service';
import { MemoryRateLimiter } from '../billing/billing.rate-limit';
import type { PrismaService } from '../db/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import type { QaCacheService } from '../qa-cache/qa-cache.service';
import type { MemoryService } from '../memory/memory.service';
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
    saveCheckpoint: ReturnType<typeof vi.fn>;
    getCheckpoint: ReturnType<typeof vi.fn>;
    truncateForResume: ReturnType<typeof vi.fn>;
    markRunning: ReturnType<typeof vi.fn>;
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
  settings: {
    getQueueConfig: ReturnType<typeof vi.fn>;
    getQaCacheConfig: ReturnType<typeof vi.fn>;
  };
  qaCache: {
    available: boolean;
    lookup: ReturnType<typeof vi.fn>;
    remember: ReturnType<typeof vi.fn>;
  };
  memory: {
    prepareContext: ReturnType<typeof vi.fn>;
    rememberAfterRun: ReturnType<typeof vi.fn>;
  };
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

/** 一个结构完整、可续跑的 checkpoint 帧。 */
function checkpointData(overrides: Partial<RunCheckpointEvent> = {}): RunCheckpointEvent {
  return {
    round: 1,
    seq: 4,
    deltas: [
      { role: 'assistant', content: '调用', toolCalls: [{ id: 'c1', name: 'search', args: {} }] },
      { role: 'tool', content: '结果', toolCallId: 'c1' },
    ],
    usage: [{ model: 'm1', input: 3, output: 2 }],
    ...overrides,
  };
}

/** DB 里的一行 RunCheckpoint：比 SSE 帧多出 runId/artifactIds/updatedAt。 */
function storedCheckpoint(
  cp: RunCheckpointEvent = checkpointData(),
  artifactIds: string[] = ['a1'],
) {
  return { runId: 'r1', ...cp, artifactIds, updatedAt: new Date() };
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
function makeExecutor(config: { maxAttempts?: number; billing?: BillingService } = {}): {
  executor: RunExecutor;
  deps: ExecutorDeps;
  metrics: ReturnType<typeof createBffMetrics>;
} {
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
      saveCheckpoint: vi.fn().mockResolvedValue(undefined),
      // 默认没有断点：普通首跑不走续跑路径。
      getCheckpoint: vi.fn().mockResolvedValue(null),
      truncateForResume: vi.fn().mockResolvedValue(undefined),
      markRunning: vi.fn().mockResolvedValue(undefined),
    },
    attachments: {
      hydrateForRun: vi.fn().mockImplementation(async (messages: unknown) => messages),
    },
    artifacts: { record: vi.fn().mockResolvedValue(undefined) },
    billing: (config.billing ??
      {
        beginRun: vi.fn().mockResolvedValue({
          maxCredits: 50,
          allowedModels: ['m1'],
          prices: {},
        }),
        recordUsage: vi.fn().mockResolvedValue(undefined),
        settle: vi.fn().mockResolvedValue(undefined),
        releaseHold: vi.fn().mockResolvedValue(undefined),
      }) as unknown as ExecutorDeps['billing'],
    events: { publish: vi.fn().mockResolvedValue(undefined) },
    control: { subscribe: vi.fn().mockResolvedValue(off) },
    settings: {
      getQueueConfig: vi.fn().mockResolvedValue({
        maxAttempts: config.maxAttempts ?? 2,
        perTenantConcurrency: 2,
        maxPerTenant: 50,
      }),
      getQaCacheConfig: vi.fn().mockResolvedValue({ enabled: true, ttlSeconds: 300 }),
    },
    qaCache: {
      available: true,
      lookup: vi.fn().mockResolvedValue(null),
      remember: vi.fn().mockResolvedValue(undefined),
    },
    memory: {
      prepareContext: vi
        .fn()
        .mockImplementation(async ({ snapshot }: { snapshot: RunSnapshot }) => ({
          messages: snapshot.messages,
          sections: [],
        })),
      rememberAfterRun: vi.fn().mockResolvedValue(undefined),
    },
    off,
  };
  vi.stubGlobal('fetch', deps.fetch);
  const metrics = createBffMetrics({ defaultMetrics: false });
  const executor = new RunExecutor(
    deps.tasks as unknown as TasksService,
    deps.attachments as unknown as AttachmentsService,
    deps.artifacts as unknown as ArtifactService,
    deps.billing as unknown as BillingService,
    deps.events as unknown as RunEventBus,
    deps.control as unknown as RunControlBus,
    metrics,
    deps.settings as unknown as SettingsService,
    deps.qaCache as unknown as QaCacheService,
    deps.memory as unknown as MemoryService,
  );
  return { executor, deps, metrics };
}

/**
 * 真实 BillingService + 只覆盖 beginRun/releaseHold 所需模型的内存版 Prisma。
 * 崩溃重投用例必须走真实 beginRun，否则把「同 runId 旧 hold 仍在」的实现缺陷掩盖掉。
 */
function makeRealBilling() {
  const plan = {
    id: 'free',
    name: '体验版',
    priceCents: 0,
    monthlyBaseCredits: 500,
    monthlyBonusCredits: 0,
    maxCreditsPerRun: 50,
    rpm: 10,
    allowedModels: ['m1'],
    active: true,
  };
  const now = Date.now();
  const subscription = {
    id: 'sub1',
    tenantId: 't1',
    planId: 'free',
    status: 'active',
    periodStart: new Date(now - 86_400_000),
    periodEnd: new Date(now + 86_400_000),
  };
  const credit = { tenantId: 't1', balance: 500, reserved: 0 };
  // 记录每次 reserved 变化后的值，用于断言重投期间预占从未被重复累加。
  const reservedHistory: number[] = [];
  const holds = new Map<
    string,
    { runId: string; tenantId: string; amount: number; expiresAt: Date }
  >();

  const tx = {
    $queryRaw: async () => [],
    tenantCredit: {
      upsert: async () => credit,
      findUnique: async () => credit,
      update: async ({ data }: any) => {
        if (data.reserved?.increment) credit.reserved += data.reserved.increment;
        if (data.reserved?.decrement) credit.reserved -= data.reserved.decrement;
        reservedHistory.push(credit.reserved);
        return credit;
      },
    },
    creditLot: { findMany: async () => [] },
    creditHold: {
      findUnique: async ({ where }: any) => holds.get(where.runId) ?? null,
      create: async ({ data }: any) => {
        // 真实库这里会因 runId 主键冲突抛 P2002：保留该语义才能验证幂等。
        if (holds.has(data.runId)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { createdAt: new Date(now), ...data };
        holds.set(data.runId, row);
        return row;
      },
      delete: async ({ where }: any) => {
        holds.delete(where.runId);
        return {};
      },
    },
    modelConfig: {
      findMany: async () => [
        { model: 'm1', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
      ],
    },
  };

  const prisma = {
    subscription: { findUnique: async () => ({ ...subscription, plan }) },
    $transaction: async (fn: any) => fn(tx),
  } as unknown as PrismaService;

  return {
    billing: new BillingService(prisma, new MemoryRateLimiter()),
    holds,
    credit,
    reservedHistory,
  };
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
  vi.restoreAllMocks();
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

  it('markRunning 推进成功时先下发 running 状态，排队文案不必等首个增量', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.markRunning.mockResolvedValue(true);
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.events.publish).toHaveBeenNthCalledWith(1, 'r1', {
      event: 'status',
      data: { runId: 'r1', status: 'running' },
    });
    expect(publishedEvents(deps)).toEqual(['status', 'step', 'done']);
  });

  it('重试时 markRunning 未推进状态则不重复下发 running', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.markRunning.mockResolvedValue(false);
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(publishedEvents(deps)).toEqual(['step', 'done']);
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

  it('命中问答缓存时把此前回答作为参考追加到系统提示词', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockResolvedValue({
      ...snapshot(),
      mode: 'chat',
      assistant: { systemPrompt: '你是写作助手' },
    });
    deps.qaCache.lookup.mockResolvedValue({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      question: '写个总结',
      answer: '上次的回答',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt: string;
    };
    // 顺序必须是：助手提示词 → 任务分类提示 → 缓存参考，后者不能插队覆盖前两者。
    const assistantIdx = body.systemPrompt.indexOf('你是写作助手');
    const modeIdx = body.systemPrompt.indexOf(SESSION_MODE_PROMPTS.chat);
    const cacheRefIdx = body.systemPrompt.indexOf('## 会话内历史回答参考');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(modeIdx).toBeGreaterThan(assistantIdx);
    expect(cacheRefIdx).toBeGreaterThan(modeIdx);
    expect(body.systemPrompt.startsWith('你是写作助手')).toBe(true);
    expect(body.systemPrompt).toContain('【问题】写个总结');
    expect(body.systemPrompt).toContain('【此前回答】上次的回答');
    expect(deps.qaCache.lookup).toHaveBeenCalledWith({
      userId: 'u1',
      sessionId: 's1',
      question: '写个总结',
    });
  });

  it('命中答案超过上限时截断注入，避免挤占上下文', async () => {
    const { executor, deps } = makeExecutor();
    const longAnswer = `${'A'.repeat(4_000)}TAIL-AFTER-LIMIT`;
    deps.qaCache.lookup.mockResolvedValue({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      question: '写个总结',
      answer: longAnswer,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt: string;
    };
    // 只保留前 4000 字并显式标注截断，尾部内容绝不能进入提示词。
    expect(body.systemPrompt).toContain(`${'A'.repeat(4_000)}\n…（已截断）`);
    expect(body.systemPrompt).not.toContain('TAIL-AFTER-LIMIT');
  });

  it('截断恰好切在代理对中间时丢弃半个字符，不留下孤立高代理', async () => {
    const { executor, deps } = makeExecutor();
    // 3999 个 A 占据码元 0-3998；emoji 占据 3999-4000，朴素的 slice(0, 4000)
    // 会把高代理（3999）留在末尾，产生孤立代理。
    const longAnswer = `${'A'.repeat(3_999)}😀TAIL`;
    deps.qaCache.lookup.mockResolvedValue({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      question: '写个总结',
      answer: longAnswer,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt: string;
    };
    // 修复后截断部分正好停在 3999 个 A，随后紧跟截断标记；半个 emoji 与尾部内容都不得注入。
    expect(body.systemPrompt).toContain(`${'A'.repeat(3_999)}\n…（已截断）`);
    expect(body.systemPrompt).not.toContain('😀');
    expect(body.systemPrompt).not.toContain('TAIL');
    // 孤立代理（高代理后面不跟低代理）一旦出现就会破坏提示词编码。
    expect(body.systemPrompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('缓存服务不可用时短路：不读配置，也不读/写缓存，仍正常收尾', async () => {
    const { executor, deps } = makeExecutor();
    deps.qaCache.available = false;
    // 非空成功答案确保 remember 的断言不是空转：短路必须发生在写入判断之前。
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '最终答案' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    // 读取与写入两条路径都应在读配置前短路。
    expect(deps.settings.getQaCacheConfig).not.toHaveBeenCalled();
    expect(deps.qaCache.lookup).not.toHaveBeenCalled();
    expect(deps.qaCache.remember).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '最终答案', 's1');
  });

  it('缓存开关关闭时不读取也不注入参考', async () => {
    const { executor, deps } = makeExecutor();
    deps.settings.getQaCacheConfig.mockResolvedValue({ enabled: false, ttlSeconds: 300 });
    // 必须有非空成功答案，否则 remember 的断言是空转的。
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '最终答案' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '最终答案', 's1');
    expect(deps.qaCache.lookup).not.toHaveBeenCalled();
    expect(deps.qaCache.remember).not.toHaveBeenCalled();
    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt?: string;
    };
    expect(body.systemPrompt).toBeUndefined();
  });

  it('缓存读取异常只记日志，不注入且不影响运行', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { executor, deps } = makeExecutor();
    deps.qaCache.lookup.mockRejectedValue(new Error('redis down'));
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt?: string;
    };
    expect(body.systemPrompt).toBeUndefined();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('读取问答缓存失败'))).toBe(true);
  });

  it('问答缓存配置读取失败时跳过缓存且不影响运行', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { executor, deps } = makeExecutor();
    deps.settings.getQaCacheConfig.mockRejectedValue(new Error('db down'));
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '最终答案' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '最终答案', 's1');
    expect(deps.qaCache.lookup).not.toHaveBeenCalled();
    expect(deps.qaCache.remember).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('读取问答缓存失败'))).toBe(true);
  });

  it('运行成功且答案非空时写入问答缓存', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '最终答案' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.qaCache.remember).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      question: '写个总结',
      answer: '最终答案',
      ttlSeconds: 300,
    });
  });

  it('失败、取消或空答案不写入问答缓存', async () => {
    const failed = makeExecutor({ maxAttempts: 1 });
    failed.deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) },
        { event: 'error', data: { message: 'boom' } },
      ]),
    );
    await failed.executor.execute(job());
    expect(failed.deps.qaCache.remember).not.toHaveBeenCalled();

    const canceled = makeExecutor();
    let handler: ((msg: RunControlMessage) => void) | undefined;
    canceled.deps.control.subscribe.mockImplementation(
      async (_runId: string, h: typeof handler) => {
        handler = h;
        return canceled.deps.off;
      },
    );
    let stepConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => {
      stepConsumed = resolve;
    });
    canceled.deps.tasks.recordStep.mockImplementation(async () => stepConsumed());
    canceled.deps.fetch.mockImplementation((_url: unknown, init: { signal: AbortSignal }) =>
      Promise.resolve(
        hangingSseResponse(
          [{ event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) }],
          init.signal,
        ),
      ),
    );
    const running = canceled.executor.execute(job());
    await consumed;
    handler!({ type: 'cancel' });
    await expect(running).resolves.toBeUndefined();
    expect(canceled.deps.qaCache.remember).not.toHaveBeenCalled();

    const empty = makeExecutor();
    empty.deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));
    await empty.executor.execute(job());
    expect(empty.deps.qaCache.remember).not.toHaveBeenCalled();
  });

  it('缓存写入异常不改变 run 终态', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { executor, deps } = makeExecutor();
    deps.qaCache.remember.mockRejectedValue(new Error('redis down'));
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '最终答案' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await expect(executor.execute(job())).resolves.toBeUndefined();

    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '最终答案', 's1');
    expect(publishedEvents(deps)).toEqual(['step', 'done']);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('写入问答缓存失败'))).toBe(true);
  });

  it('任务分类提示追加在助手提示词之后', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockResolvedValue({
      ...snapshot(),
      mode: 'code',
      assistant: { systemPrompt: '你是写作助手' },
    });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt: string;
      mode: string;
    };
    expect(body.systemPrompt.startsWith('你是写作助手')).toBe(true);
    expect(body.systemPrompt).toContain(SESSION_MODE_PROMPTS.code);
    // runtime 依此在模型零产出时兜底落一份结果文件。
    expect(body.mode).toBe('code');
  });

  it('未绑定助手时仍下发分类提示', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.loadSnapshot.mockResolvedValue({ ...snapshot(), mode: 'chat' });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      systemPrompt: string;
    };
    expect(body.systemPrompt).toBe(SESSION_MODE_PROMPTS.chat);
  });

  it('web 端默认执行：confirm 级工具不再等确认，只读助手仍保持只读', async () => {
    const { executor, deps } = makeExecutor();
    deps.fetch.mockImplementation(async () =>
      sseResponse([{ event: 'done', data: { runId: 'r1' } }]),
    );

    const modes: Array<{ assistant: RunSnapshot['assistant'] }> = [
      { assistant: null },
      { assistant: { permissionMode: 'standard' } },
      { assistant: { permissionMode: 'readonly' } },
    ];
    for (const { assistant } of modes) {
      deps.tasks.loadSnapshot.mockResolvedValue({ ...snapshot(), assistant });
      await executor.execute(job());
    }

    const sent = deps.fetch.mock.calls.map(
      (call) => JSON.parse(String(call[1]!.body)) as { permissionMode: string },
    );
    expect(sent.map((b) => b.permissionMode)).toEqual(['auto', 'auto', 'readonly']);
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

  it('流式阶段取消且已有断点：用断点用量结算，避免取消漏计', async () => {
    const { executor, deps } = makeExecutor();
    // 已完成轮次的用量只存在于断点里：取消断开上游后 usage 帧不可能再回传。
    const cp = checkpointData();
    deps.tasks.getCheckpoint.mockResolvedValue(storedCheckpoint(cp));
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

    expect(deps.billing.recordUsage).toHaveBeenCalledWith(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      { input: 3, output: 2, models: [{ model: 'm1', input: 3, output: 2 }] },
    );
    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.billing.releaseHold).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
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

  it('confirm 转发收到 matched:false 时记录告警，run 仍正常收尾', async () => {
    // matched:false 表示决策来晚了或 confirmId 不符，过去完全不可见；必须留下可诊断日志。
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, matched: false }), { status: 200 }),
        );
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
    handler!({ type: 'confirm', confirmId: 'c1', approved: true });

    // 断言必须等转发落定：控制分发不 await，只能轮询告警是否出现。
    await vi.waitFor(() => {
      const unmatched = warn.mock.calls.find(
        ([msg]) => String(msg).includes('confirmId=c1') && String(msg).includes('matched=false'),
      );
      expect(unmatched).toBeDefined();
    });

    // 告警后 run 仍可正常取消收尾，转发绝不把异常抛回执行流程。
    handler!({ type: 'cancel' });
    await expect(running).resolves.toBeUndefined();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(publishedEvents(deps)[publishedEvents(deps).length - 1]).toBe('status');
  });

  it('confirm 转发收到 500 时记录告警，run 仍正常收尾', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
        return Promise.resolve(new Response('boom', { status: 500 }));
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
    handler!({ type: 'confirm', confirmId: 'c1', approved: true });

    await vi.waitFor(() => {
      const failed = warn.mock.calls.find(([msg]) => String(msg).includes('HTTP 500'));
      expect(failed).toBeDefined();
    });

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

  it('执行前已有取消请求时跳过上游并释放预占', async () => {
    // 运行中收到的取消：cancelRequestedAt 兜底预检。
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

  it.each(['done', 'failed', 'canceled'] as const)(
    'run 已是终态 %s 时跳过重复执行，不预占、不 finish、不发布',
    async (status) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { executor, deps } = makeExecutor();
      // 停滞后重投：run 已收尾，但作业被再次执行。
      deps.tasks.findRun.mockResolvedValue({
        id: 'r1',
        status,
        lastError: null,
        cancelRequestedAt: null,
      });

      await executor.execute(job());

      expect(warn.mock.calls.some(([msg]) => String(msg).includes(`已是终态 ${status}`))).toBe(
        true,
      );
      expect(deps.billing.beginRun).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(deps.tasks.finish).not.toHaveBeenCalled();
      expect(deps.billing.recordUsage).not.toHaveBeenCalled();
      expect(deps.billing.settle).not.toHaveBeenCalled();
      expect(deps.billing.releaseHold).not.toHaveBeenCalled();
      expect(deps.events.publish).not.toHaveBeenCalled();
      // 提前返回也必须退订控制消息，避免订阅泄漏。
      expect(deps.off).toHaveBeenCalledTimes(1);
    },
  );

  it('终态守卫查询失败时记日志并继续执行', async () => {
    const { executor, deps } = makeExecutor();
    // run 缺失/DB 抖动不阻断：后续 beginRun 与快照校验仍会安全失败。
    deps.tasks.findRun.mockRejectedValueOnce(new Error('db down'));
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
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

  it('建连 ECONNRESET 后从断点续跑：只预占一次、携带 resume 并计入续跑指标', async () => {
    const { executor, deps, metrics } = makeExecutor({ maxAttempts: 2 });
    const cp = checkpointData();
    // 首次尝试没有断点，传输中断前一次完整轮落的断点在第二次尝试前读回。
    deps.tasks.getCheckpoint.mockResolvedValueOnce(null).mockResolvedValue(storedCheckpoint(cp));
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    deps.fetch
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(
        sseResponse([
          {
            event: 'usage',
            data: { input: 9, output: 4, models: [{ model: 'm1', input: 9, output: 4 }] },
          },
          { event: 'done', data: { runId: 'r1' } },
        ]),
      );
    const resumed = vi.spyOn(metrics.runsResumed, 'inc');

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // 重试共用同一笔预占，绝不能重复 beginRun。
    expect(deps.billing.beginRun).toHaveBeenCalledTimes(1);
    expect(deps.tasks.markRunning).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(deps.fetch.mock.calls[1]![1].body)) as {
      resume: RunCheckpointEvent;
    };
    expect(body.resume).toEqual(cp);
    expect(deps.tasks.truncateForResume).toHaveBeenCalledWith('r1', {
      seq: cp.seq,
      artifactIds: ['a1'],
    });
    // 只按最终尝试的用量记一次账，中间失败尝试不得重复结算。
    const finalUsage = { input: 9, output: 4, models: [{ model: 'm1', input: 9, output: 4 }] };
    expect(deps.billing.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.billing.recordUsage).toHaveBeenCalledWith(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      finalUsage,
    );
    expect(deps.billing.settle).toHaveBeenCalledTimes(1);
    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('重试达到 maxAttempts 后失败收尾并释放预占', async () => {
    const { executor, deps, metrics } = makeExecutor({ maxAttempts: 2 });
    deps.fetch.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    const resumed = vi.spyOn(metrics.runsResumed, 'inc');

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // 无用量时只归还一次预占，绝不结算。
    expect(deps.billing.releaseHold).toHaveBeenCalledTimes(1);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.billing.recordUsage).not.toHaveBeenCalled();
    expect(deps.billing.settle).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(lastErrorData(deps)).toEqual({
      message: '模型服务不可达，请稍后重试',
      error: 'upstream_unreachable',
    });
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('上游 4xx 不重试，直接按 failed 收尾', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 3 });
    deps.fetch.mockResolvedValue(new Response('bad request', { status: 400 }));

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(lastErrorData(deps)).toEqual({
      message: '模型服务返回错误，请稍后重试',
      error: 'upstream_error',
    });
  });

  it('干净 EOF 但没有 done 帧时重试并成功', async () => {
    const { executor, deps, metrics } = makeExecutor({ maxAttempts: 2 });
    deps.fetch
      .mockResolvedValueOnce(
        // 连接中途断开：只有半截 step，没有 done/error。
        sseResponse([{ event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) }]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { event: 'step', data: stepEvent(0, 'think', { text: '完整回答' }) },
          { event: 'done', data: { runId: 'r1' } },
        ]),
      );
    const resumed = vi.spyOn(metrics.runsResumed, 'inc');

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // 最终回答只取最后一次尝试的 think 文本，不能把重放轮次拼出重复内容。
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '完整回答', 's1');
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('重试时每次尝试都查一次缓存，最终成功只写一次', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 2 });
    deps.fetch
      .mockResolvedValueOnce(
        sseResponse([{ event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) }]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { event: 'step', data: stepEvent(0, 'think', { text: '完整回答' }) },
          { event: 'done', data: { runId: 'r1' } },
        ]),
      );

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // 注入属于每次尝试的准备阶段；写入只在最终成功收尾时发生一次。
    expect(deps.qaCache.lookup).toHaveBeenCalledTimes(2);
    expect(deps.qaCache.remember).toHaveBeenCalledTimes(1);
    expect(deps.qaCache.remember).toHaveBeenCalledWith(
      expect.objectContaining({ answer: '完整回答' }),
    );
  });

  it('无断点重试时先清空 seq 0 的旧步骤，再从头发起第二次尝试', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 2 });
    deps.fetch
      .mockResolvedValueOnce(
        // 首轮中途断流：已落了 seq 0 的 step，但没有任何 checkpoint 帧。
        sseResponse([{ event: 'step', data: stepEvent(0, 'think', { text: '半截回答' }) }]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { event: 'step', data: stepEvent(0, 'think', { text: '完整回答' }) },
          { event: 'done', data: { runId: 'r1' } },
        ]),
      );

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // 无断点时 runtime 从 seq 0 重放：第二次尝试前必须删掉旧的 seq 0 步骤，
    // 否则 recordStep 会撞 (runId, seq) 唯一键并被误判为本地持久化失败。
    expect(deps.tasks.truncateForResume).toHaveBeenCalledWith('r1', {
      seq: 0,
      artifactIds: [],
    });
    const truncateOrder = deps.tasks.truncateForResume.mock.invocationCallOrder;
    expect(truncateOrder[truncateOrder.length - 1]!).toBeLessThan(
      deps.fetch.mock.invocationCallOrder[1]!,
    );
    // 无断点就不带 resume：第二次尝试仍是从头跑。
    const body = JSON.parse(String(deps.fetch.mock.calls[1]![1].body)) as { resume?: unknown };
    expect(body.resume).toBeUndefined();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '完整回答', 's1');
  });

  it('markRunning 之后才出现的取消不再发起上游并收尾为 canceled', async () => {
    const { executor, deps } = makeExecutor();
    let runningMarked = false;
    // 排队取消可能正好落在预检与状态推进之间：markRunning 之后才查得到 canceled。
    deps.tasks.markRunning.mockImplementation(async () => {
      runningMarked = true;
    });
    deps.tasks.findRun.mockImplementation(async () => ({
      id: 'r1',
      status: runningMarked ? 'canceled' : 'running',
      lastError: null,
      cancelRequestedAt: null,
    }));

    await executor.execute(job());

    expect(deps.tasks.markRunning).toHaveBeenCalledWith('r1', 't1');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    // 取消只发 status 帧，绝不能发 error（取消不是故障）。
    expect(publishedEvents(deps)).toEqual(['status']);
  });

  it('runtime 的 error 帧不重试，直接按 run_failed 收尾', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 3 });
    deps.fetch.mockResolvedValue(
      sseResponse([{ event: 'error', data: { message: 'runtime boom' } }]),
    );

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(lastErrorData(deps)).toEqual({
      message: '本次运行失败，请稍后重试',
      error: 'run_failed',
    });
  });

  it('checkpoint 帧落库但不转发到事件总线', async () => {
    const { executor, deps } = makeExecutor();
    const cp = checkpointData();
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        { event: 'checkpoint', data: cp },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.tasks.saveCheckpoint).toHaveBeenCalledWith('r1', cp);
    // 浏览器只能看到 step 与 done；checkpoint 属于执行器内部状态。
    expect(publishedEvents(deps)).toEqual(['step', 'done']);
    expect(publishedEvents(deps)).not.toContain('checkpoint');
  });

  it('非法 checkpoint 帧被忽略，不影响运行', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { executor, deps } = makeExecutor();
    deps.fetch.mockResolvedValue(
      sseResponse([
        // round 非法：整帧拒绝，不能把半截断点写进 DB。
        { event: 'checkpoint', data: { round: -1, seq: 0, deltas: [], usage: [] } },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.tasks.saveCheckpoint).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
    expect(
      warn.mock.calls.some(([msg]) => String(msg).includes('checkpoint 事件非法')),
    ).toBe(true);
  });

  it('崩溃重投时旧 hold 仍在，真实 beginRun 复用预占并从断点续跑', async () => {
    // 上一个 worker 已 beginRun 并落了断点后崩溃：CreditHold.runId 主键上的旧行仍在。
    const real = makeRealBilling();
    await real.billing.beginRun('r1', 't1');
    expect(real.credit.reserved).toBe(50);
    expect(real.holds.size).toBe(1);

    const { executor, deps } = makeExecutor({ billing: real.billing });
    const cp = checkpointData();
    deps.tasks.getCheckpoint.mockResolvedValue(storedCheckpoint(cp));
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    // 旧 hold 不能被当成 P2002 或可用余额不足而判成 run_failed：必须续跑并正常收尾。
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.tasks.truncateForResume).toHaveBeenCalledWith('r1', {
      seq: cp.seq,
      artifactIds: ['a1'],
    });
    const body = JSON.parse(String(deps.fetch.mock.calls[0]![1].body)) as {
      resume: RunCheckpointEvent;
    };
    expect(body.resume).toEqual(cp);
    // 全程 reserved 只累加过一次（50），最终由 releaseHold 归还（无 usage）。
    expect(Math.max(...real.reservedHistory)).toBe(50);
    expect(real.credit.reserved).toBe(0);
    expect(real.holds.size).toBe(0);
  });

  it('已落库断点结构非法时失败收尾，不静默从头重跑', async () => {
    const { executor, deps } = makeExecutor();
    deps.tasks.getCheckpoint.mockResolvedValue({
      runId: 'r1',
      round: 1,
      seq: -1,
      deltas: [],
      usage: [],
      artifactIds: [],
      updatedAt: new Date(),
    });

    await executor.execute(job());

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.tasks.truncateForResume).not.toHaveBeenCalled();
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'failed', '', 's1');
    expect(lastErrorData(deps).error).toBe('run_failed');
  });

  it('两次尝试之间请求取消时停止续跑并按 canceled 收尾', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 3 });
    const clear = { id: 'r1', status: 'running', lastError: null, cancelRequestedAt: null };
    const canceledRow = { ...clear, cancelRequestedAt: new Date() };
    // 调用顺序：终态守卫 → 预检 → 首次尝试前 → attempt 内建连前复查 → 建连失败后的取消检查
    // → 第二次尝试前。
    deps.tasks.findRun
      .mockResolvedValueOnce(clear)
      .mockResolvedValueOnce(clear)
      .mockResolvedValueOnce(clear)
      .mockResolvedValueOnce(clear)
      .mockResolvedValueOnce(clear)
      .mockResolvedValue(canceledRow);
    deps.fetch.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.billing.releaseHold).toHaveBeenCalledWith('r1');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(publishedEvents(deps)).toEqual(['status']);
  });

  it('断点读取后、发起 fetch 前落库的取消不再请求上游', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 2 });
    const clear = { id: 'r1', status: 'running', lastError: null, cancelRequestedAt: null };
    const canceledRow = { ...clear, cancelRequestedAt: new Date() };
    // 终态守卫 → 预检 → 尝试前检查均正常；attempt 内建连前的复查才发现取消。
    deps.tasks.findRun
      .mockResolvedValueOnce(clear)
      .mockResolvedValueOnce(clear)
      .mockResolvedValueOnce(clear)
      .mockResolvedValue(canceledRow);
    // 断点已读回：取消恰好落在这之后、fetch 之前。
    deps.tasks.getCheckpoint.mockResolvedValue(storedCheckpoint());
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    // 续跑前读一次断点，取消收尾时再读一次用于结算已完成轮次的用量。
    expect(deps.tasks.getCheckpoint).toHaveBeenCalledTimes(2);
    expect(deps.fetch).not.toHaveBeenCalled();
    // 断点里已有上一轮的实际用量：取消也要结算，不能直接释放预占。
    expect(deps.billing.recordUsage).toHaveBeenCalledWith(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      { input: 3, output: 2, models: [{ model: 'm1', input: 3, output: 2 }] },
    );
    expect(deps.billing.settle).toHaveBeenCalledWith('r1');
    expect(deps.billing.releaseHold).not.toHaveBeenCalled();
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'canceled', '', 's1');
    expect(publishedEvents(deps)).toEqual(['status']);
  });

  it('每次尝试都在发起 fetch 之前推进 running 状态', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 1 });
    deps.fetch.mockResolvedValue(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    expect(deps.tasks.markRunning).toHaveBeenCalledWith('r1', 't1');
    expect(deps.tasks.markRunning.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.fetch.mock.invocationCallOrder[0]!,
    );
  });

  it('记忆窗口替换下发消息，段落按长期记忆→会话摘要顺序进入 systemPrompt', async () => {
    const { executor, deps } = makeExecutor();
    deps.memory.prepareContext.mockResolvedValueOnce({
      messages: [{ role: 'user', content: '最近问题', attachments: [] }],
      sections: ['## 用户长期记忆\n- 偏好简洁', '## 会话早期摘要\n早前内容'],
    });
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.memory.prepareContext).toHaveBeenCalledWith({
      job: job(),
      snapshot: expect.objectContaining({ goal: '写个总结' }),
      modelRoutes: [],
    });
    expect(deps.attachments.hydrateForRun).toHaveBeenCalledWith([
      { role: 'user', content: '最近问题', attachments: [] },
    ]);
    const body = JSON.parse(String((deps.fetch.mock.calls[0][1] as RequestInit).body)) as {
      messages: unknown;
      systemPrompt: string;
    };
    expect(body.messages).toEqual([{ role: 'user', content: '最近问题', attachments: [] }]);
    const longTermIdx = body.systemPrompt.indexOf('## 用户长期记忆');
    const summaryIdx = body.systemPrompt.indexOf('## 会话早期摘要');
    expect(longTermIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(longTermIdx);
  });

  it('done 后调用 rememberAfterRun；写入失败不影响终态', async () => {
    const { executor, deps } = makeExecutor();
    deps.memory.rememberAfterRun.mockRejectedValueOnce(new Error('boom'));
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: '完成' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.memory.rememberAfterRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'done',
        assistantText: '完成',
        job: job(),
      }),
    );
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '完成', 's1');
    expect(deps.events.publish).toHaveBeenCalledWith('r1', {
      event: 'done',
      data: { runId: 'r1' },
    });
  });

  it('记忆准备抛错时退回全量历史，运行照常完成', async () => {
    const { executor, deps } = makeExecutor();
    deps.memory.prepareContext.mockRejectedValueOnce(new Error('memory down'));
    deps.fetch.mockResolvedValue(
      sseResponse([
        { event: 'step', data: stepEvent(0, 'think', { text: 'hi' }) },
        { event: 'done', data: { runId: 'r1' } },
      ]),
    );

    await executor.execute(job());

    expect(deps.attachments.hydrateForRun).toHaveBeenCalledWith(
      snapshot().messages,
    );
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', 'hi', 's1');
  });

  it('重试复用同一份记忆上下文，只准备一次', async () => {
    const { executor, deps } = makeExecutor({ maxAttempts: 2 });
    deps.memory.prepareContext.mockResolvedValueOnce({
      messages: [{ role: 'user', content: '窗口问题', attachments: [] }],
      sections: ['## 用户长期记忆\n- 偏好简洁'],
    });
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    deps.fetch
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(sseResponse([{ event: 'done', data: { runId: 'r1' } }]));

    await executor.execute(job());

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // 记忆准备发生在重试循环之外：重试不得重复调用模型/embedding。
    expect(deps.memory.prepareContext).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String((deps.fetch.mock.calls[0]![1] as RequestInit).body)) as {
      messages: unknown;
      systemPrompt: string;
    };
    const second = JSON.parse(String((deps.fetch.mock.calls[1]![1] as RequestInit).body)) as {
      messages: unknown;
      systemPrompt: string;
    };
    expect(first.messages).toEqual([{ role: 'user', content: '窗口问题', attachments: [] }]);
    expect(second.messages).toEqual(first.messages);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.systemPrompt).toContain('## 用户长期记忆');
    expect(deps.tasks.finish).toHaveBeenCalledWith('r1', 't1', 'done', '', 's1');
  });
});

describe('parseCheckpoint', () => {
  it('round 超过 Int 上限时拒绝，否则每次续跑都会被 runtime 400 invalid_resume', () => {
    // [MAX, 2^31) 的 round 能落库，但 runtime 侧无法续跑，必须提前整帧拒绝。
    expect(
      parseCheckpoint({ round: 2_000_000_001, seq: 0, deltas: [], usage: [] }),
    ).toBeNull();
    // 边界值本身仍合法。
    expect(
      parseCheckpoint({ round: 2_000_000_000, seq: 0, deltas: [], usage: [] }),
    ).not.toBeNull();
  });
});
