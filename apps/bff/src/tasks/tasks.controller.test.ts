import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { toolsForSkills, type RunModelRoute } from '@ai-office/shared';
import { initTelemetry, shutdownTelemetry } from '@ai-office/telemetry';
import pino from 'pino';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';
import { BillingService } from '../billing/billing.service';
import { SettingsService } from '../settings/settings.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { ModelUnavailableError } from '../models/model.errors';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';
import { BFF_METRICS, createBffMetrics } from '../observability/observability.metrics';
import { registerRequestTelemetry } from '../observability/request-telemetry';
import { QueueFullError, RunQueueService } from '../queue/run-queue.service';
import { RunRelayService } from '../queue/run-relay.service';
import type { RunJob, RunSnapshot } from '../queue/run-job';
import { decryptSecret } from '../secrets/secret-box';
import { MODEL_ENC_KEY } from '../models/model.constants';

const ENC_KEY_HEX = 'a'.repeat(64);
// 快照路由加密在请求期发生，但仍提前提供密钥，避免任何路径读到未设置的密钥。
process.env.MODEL_ENC_KEY = ENC_KEY_HEX;

let app: NestFastifyApplication;
let baseUrl: string;
let prepareSpy: any;
let prepareOriginal: typeof TasksService.prototype.prepare;
// 配置读取故障注入：非空时 getRunConfig 抛错，用于验证「配置失败不预占/不入队」。
let getRunConfigError: unknown = null;
// 模型路由与排队容量故障注入。
let modelRoutes: RunModelRoute[] = [];
let assertCapacityError: unknown = null;
const assertCapacityCalls: string[] = [];
// 关键调用顺序：容量校验 → 准入 → 建单 → 入队 → 挂接。
const callOrder: string[] = [];
// 落库故障注入：验证入队失败后的清理再失败也不会掩盖响应。
let runUpdateError: unknown = null;

const stored: {
  messages: unknown[];
  runCreates: any[];
  runUpdates: any[];
  taskCreates: any[];
  taskUpdates: any[];
  sessionModelUpdates: unknown[];
} = {
  messages: [],
  runCreates: [],
  runUpdates: [],
  taskCreates: [],
  taskUpdates: [],
  sessionModelUpdates: [],
};

const session = {
  id: 's1',
  tenantId: 't1',
  userId: 'u1',
  title: 'x',
  model: 'mock' as string | null,
  assistantId: null as string | null,
  mode: 'task' as string,
  assistant: null as null | {
    id: string;
    name: string;
    systemPrompt: string;
    permissionMode: string;
    skills: string[];
    kbIds: string[];
  },
  createdAt: new Date(),
};

// 计费调用记录：创建路径只应调用 admitRun，额度预占由执行器负责。
const billingCalls: unknown[][] = [];
let admitRunError: unknown = null;
const fakeBilling = {
  admitRun: async (tenantId: string) => {
    billingCalls.push(['admit', tenantId]);
    callOrder.push('admitRun');
    if (admitRunError) throw admitRunError;
  },
  beginRun: async (...args: unknown[]) => {
    billingCalls.push(['begin', ...args]);
    return { maxCredits: 50, allowedModels: ['mock'], prices: {} };
  },
} as unknown as BillingService;

// 模型目录：断言运行前解析到的会话模型与错误分支。
const catalogCalls: unknown[][] = [];
let resolveForRunError: unknown = null;
let selectedModalities: string[] = ['text', 'image', 'audio', 'video'];
const fakeCatalog = {
  available: async () => ({
    models: [
      {
        model: 'mock',
        displayName: 'mock',
        providerName: '环境变量',
        sortOrder: 0,
        source: { kind: 'mock' as const },
      },
    ],
    defaultModel: 'mock',
  }),
  resolveForRun: async (tenantId: string, model: string | null) => {
    catalogCalls.push([tenantId, model]);
    if (resolveForRunError) throw resolveForRunError;
    return {
      selectedModel: 'mock',
      modelRoutes,
      selectedModalities,
    };
  },
} as unknown as ModelCatalogService;

// 附件预检：无附件的用例返回空；附件用例按需注入记录。
const attachmentCalls: unknown[][] = [];
let ownedAttachments: unknown[] = [];
const fakeAttachments = {
  listOwnedUnclaimed: async (ids: string[], tenantId: string, userId: string) => {
    attachmentCalls.push(['list', ids, tenantId, userId]);
    return ownedAttachments;
  },
  hydrateForRun: async () => {
    // 创建路径不再读取附件字节，改由执行器按快照水合。
    attachmentCalls.push(['hydrate']);
    throw new Error('controller must not hydrate attachments');
  },
} as unknown as AttachmentsService;

// 入队与流挂接：创建路径只负责提交作业并把回复交给转发器。
const queueCalls: RunJob[] = [];
let submitError: unknown = null;
const fakeQueue = {
  assertCapacity: async (tenantId: string) => {
    assertCapacityCalls.push(tenantId);
    callOrder.push('assertCapacity');
    if (assertCapacityError) throw assertCapacityError;
  },
  submit: async (job: RunJob) => {
    queueCalls.push(job);
    callOrder.push('submit');
    if (submitError) throw submitError;
    return 'inline' as const;
  },
} as unknown as RunQueueService;

const relayCalls: string[] = [];
let attachError: unknown = null;
const fakeRelay = {
  attach: async (runId: string, reply: FastifyReply) => {
    relayCalls.push(runId);
    callOrder.push('attach');
    if (attachError) throw attachError;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.end(`event: done\ndata: ${JSON.stringify({ runId })}\n\n`);
  },
} as unknown as RunRelayService;

const fakePrisma = {
  user: {
    // JwtGuard 会按 sub 查库校验 status/role；测试里按 token 中的 sub 返回对应租户。
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'u2' ? 'member' : 'admin',
      tenantId: where.id === 'u2' ? 't2' : 't1',
      email: `${where.id}@test.local`,
    }),
  },
  session: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      where.id === session.id && where.tenantId === session.tenantId && where.userId === session.userId
        ? session
        : null,
    updateMany: async (args: unknown) => {
      stored.sessionModelUpdates.push(args);
      return { count: 1 };
    },
  },
  message: {
    findMany: async () => [],
    findFirst: async () => null,
    create: async ({ data }: { data: unknown }) => {
      stored.messages.push(data);
      return data;
    },
  },
  attachment: {
    updateMany: async ({ where }: { where: { id: { in: string[] } } }) => ({
      count: where.id.in.length,
    }),
    findMany: async () => ownedAttachments,
  },
  task: {
    create: async ({ data }: { data: unknown }) => {
      stored.taskCreates.push(data);
      return { id: 'task1', ...(data as object) };
    },
    update: async (args: unknown) => {
      stored.taskUpdates.push(args);
      return {};
    },
  },
  run: {
    create: async ({ data }: { data: unknown }) => {
      stored.runCreates.push(data);
      return { ...(data as object) };
    },
    update: async (args: unknown) => {
      if (runUpdateError) throw runUpdateError;
      stored.runUpdates.push(args);
      return {};
    },
  },
  // 测试不需要事务隔离，直接把同一个 fake 交给回调。
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
} as unknown as PrismaService;

beforeAll(async () => {
  initTelemetry({ serviceName: 'bff-task-test', serviceVersion: '1' });
  process.env.JWT_SECRET = 'test-secret';

  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController, TasksController],
    providers: [
      SessionsService,
      TasksService,
      { provide: BillingService, useValue: fakeBilling },
      {
        provide: SettingsService,
        useValue: {
          getRunConfig: async () => {
            if (getRunConfigError) throw getRunConfigError;
            return {
              maxRounds: 3,
              confirmTimeoutMs: 1000,
              codeExecTimeoutMs: 1234,
            };
          },
        },
      },
      { provide: PrismaService, useValue: fakePrisma },
      { provide: ModelCatalogService, useValue: fakeCatalog },
      { provide: AttachmentsService, useValue: fakeAttachments },
      { provide: RunQueueService, useValue: fakeQueue },
      { provide: RunRelayService, useValue: fakeRelay },
      { provide: BFF_METRICS, useValue: createBffMetrics({ defaultMetrics: false }) },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  // 与 main.ts 一致：先建请求 span，控制器里的 currentTrace() 才有值可写入快照。
  registerRequestTelemetry(
    app.getHttpAdapter().getInstance(),
    app.get(BFF_METRICS),
    pino({ level: 'silent' }),
  );
  await app.getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

beforeEach(() => {
  stored.messages.length = 0;
  stored.runCreates.length = 0;
  stored.runUpdates.length = 0;
  stored.taskCreates.length = 0;
  stored.taskUpdates.length = 0;
  stored.sessionModelUpdates.length = 0;
  getRunConfigError = null;
  billingCalls.length = 0;
  admitRunError = null;
  catalogCalls.length = 0;
  resolveForRunError = null;
  selectedModalities = ['text', 'image', 'audio', 'video'];
  attachmentCalls.length = 0;
  ownedAttachments = [];
  queueCalls.length = 0;
  submitError = null;
  relayCalls.length = 0;
  attachError = null;
  modelRoutes = [];
  assertCapacityError = null;
  assertCapacityCalls.length = 0;
  callOrder.length = 0;
  runUpdateError = null;
  session.model = 'mock';
  session.assistantId = null;
  session.assistant = null;
  // 记录原始实现，便于个别用例在 spy 中插入调用顺序观测而不改变行为。
  prepareOriginal = TasksService.prototype.prepare;
  prepareSpy = vi.spyOn(TasksService.prototype, 'prepare');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await shutdownTelemetry();
});

/** 从落库的 task.update 中取出 prepare 补全后的最终快照。 */
function finalTaskInput(): RunSnapshot {
  const update = stored.taskUpdates.find((u) => u.data?.input) as any;
  return update.data.input as RunSnapshot;
}

describe('TasksController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('goal 非字符串或为空时返回 400，且不建 task/run', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    for (const payload of [{ goal: 123 }, { goal: '' }, {}]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/s1/tasks',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_goal' });
    }
    expect(stored.messages).toHaveLength(0);
    expect(billingCalls).toEqual([]);
  });

  it('附件 id 结构非法或数量超限时在预占前返回 400', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const headers = { authorization: `Bearer ${token}` };

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers,
      payload: { goal: 'g', attachmentIds: ['a1', ''] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.payload)).toEqual({ error: 'invalid_attachments' });

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers,
      payload: { goal: 'g', attachmentIds: Array.from({ length: 11 }, (_, i) => `a${i}`) },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(JSON.parse(tooMany.payload)).toEqual({ error: 'too_many_attachments' });
    expect(billingCalls).toEqual([]);
  });

  it('非本用户会话返回 404（hijack 必须晚于归属校验，否则请求挂起）', async () => {
    // s2 不在 fake store 里，assertOwned 抛 NotFoundException。
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s2/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(404);
    expect(billingCalls).toEqual([]);
    expect(queueCalls).toEqual([]);
  });

  it('读取运行参数失败时不预占、不入队', async () => {
    getRunConfigError = new Error('injected settings failure');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(500);
    expect(billingCalls).toEqual([]);
    expect(stored.messages).toHaveLength(0);
    expect(queueCalls).toEqual([]);
  });

  it('模型解析失败时不预占、不建 task，并返回明确状态码', async () => {
    resolveForRunError = new ModelUnavailableError();
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ error: 'model_unavailable' });
    expect(billingCalls).toEqual([]);
    expect(stored.runCreates).toHaveLength(0);
  });

  it('可用积分不足返回 402', async () => {
    admitRunError = new InsufficientCreditsError();
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: '写个总结' },
    });
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.payload)).toEqual({ error: 'insufficient_credits' });
    // 准入失败发生在建 task/run 之前。
    expect(stored.messages).toHaveLength(0);
    expect(queueCalls).toEqual([]);
  });

  it('套餐过期返回 402，限流返回 429', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const headers = { authorization: `Bearer ${token}` };

    admitRunError = new PlanExpiredError();
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/tasks`,
      headers,
      payload: { goal: '写个总结' },
    });
    expect(r1.statusCode).toBe(402);
    expect(JSON.parse(r1.payload)).toEqual({ error: 'plan_expired' });

    admitRunError = new RateLimitedError(30);
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/tasks`,
      headers,
      payload: { goal: '写个总结' },
    });
    expect(r2.statusCode).toBe(429);
    expect(r2.headers['retry-after']).toBe('30');
    expect(JSON.parse(r2.payload)).toEqual({ error: 'rate_limited', retryAfter: 30 });
  });

  it('准入后把运行快照入队并挂接事件流', async () => {
    session.assistantId = 'as1';
    session.assistant = {
      id: 'as1',
      name: '写作助手',
      systemPrompt: ' 你是写作助手 ',
      permissionMode: 'readonly',
      skills: ['web'],
      kbIds: ['kb1'],
    };
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        traceparent: `00-${traceId}-b7ad6b7169203331-01`,
      },
      body: JSON.stringify({ goal: '查竞品' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');

    // 创建路径只做准入，不再预占；预占由执行器在真正执行时完成。
    expect(billingCalls).toEqual([['admit', 't1']]);
    expect(billingCalls.some((c) => c[0] === 'begin')).toBe(false);

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const args = prepareSpy.mock.calls[0];
    expect(args.slice(0, 7)).toEqual(['s1', 't1', 'u1', '查竞品', expect.any(String), traceId, []]);
    const runId = args[4] as string;
    const snapshot = args[7] as RunSnapshot;
    expect(snapshot).toEqual({
      goal: '查竞品',
      model: 'mock',
      resolution: { selectedModel: 'mock', modelRoutes: [] },
      config: { maxRounds: 3, confirmTimeoutMs: 1000, codeExecTimeoutMs: 1234 },
      traceId,
      mode: 'task',
      assistant: {
        systemPrompt: '你是写作助手',
        enabledTools: toolsForSkills(['web']),
        permissionMode: 'readonly',
        kbIds: ['kb1'],
      },
      messages: [],
    });

    // 入队作业只带标识，执行细节全部来自快照。
    expect(queueCalls).toEqual([
      { runId, taskId: 'task1', sessionId: 's1', tenantId: 't1', userId: 'u1' },
    ]);
    expect(relayCalls).toEqual([runId]);

    expect(stored.runCreates[0]).toMatchObject({
      id: runId,
      taskId: 'task1',
      status: 'queued',
      traceId,
    });
    expect(stored.runCreates[0].startedAt).toBeUndefined();
    // prepare 把「历史 + 本次用户消息」写回快照。
    expect(finalTaskInput().messages).toEqual([
      { role: 'user', content: '查竞品', attachments: [] },
    ]);
    // 会话模型回填已移到执行器，创建路径不写会话。
    expect(stored.sessionModelUpdates).toHaveLength(0);
  });

  it('会话无模型时快照记录 null，由执行器在运行时回填', async () => {
    session.model = null;
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const snapshot = prepareSpy.mock.calls[0][7] as RunSnapshot;
    expect(snapshot.model).toBeNull();
    expect(snapshot.resolution.selectedModel).toBe('mock');
    expect(stored.sessionModelUpdates).toHaveLength(0);
  });

  it('快照落库前加密厂商密钥，不在 Task.input 留明文', async () => {
    modelRoutes = [{ model: 'm1', baseUrl: 'https://ark.example/v3', apiKey: 'sk-plain' }];
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const snapshot = prepareSpy.mock.calls[0][7] as RunSnapshot;
    const sealed = snapshot.resolution.modelRoutes[0]!;
    expect(sealed.apiKey).not.toBe('sk-plain');
    expect(decryptSecret(sealed.apiKey, MODEL_ENC_KEY)).toBe('sk-plain');
    // prepare 把同一个 resolution 写回 Task.input，落库值同样不能是明文。
    const persisted = finalTaskInput().resolution.modelRoutes[0]!;
    expect(persisted.apiKey).not.toBe('sk-plain');
    expect(decryptSecret(persisted.apiKey, MODEL_ENC_KEY)).toBe('sk-plain');
  });

  it('排队容量预检拒绝时返回 429，且不准入、不建单、不入队', async () => {
    assertCapacityError = new QueueFullError('t1');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.payload)).toEqual({ error: 'queue_full' });
    expect(assertCapacityCalls).toEqual(['t1']);
    expect(billingCalls).toEqual([]);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(queueCalls).toEqual([]);
    expect(stored.messages).toHaveLength(0);
  });

  it('容量校验在准入、建单、入队与挂接之前依次进行', async () => {
    // 只观测顺序，仍用真实 prepare 落库。
    prepareSpy.mockImplementation((...args: Parameters<typeof prepareOriginal>) => {
      callOrder.push('prepare');
      return prepareOriginal.call(app.get(TasksService), ...args);
    });
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(callOrder).toEqual(['assertCapacity', 'admitRun', 'prepare', 'submit', 'attach']);
  });

  it('排队已满时标记刚创建的任务失败并返回 429', async () => {
    submitError = new QueueFullError('t1');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.payload)).toEqual({ error: 'queue_full' });
    expect(queueCalls).toHaveLength(1);
    expect(relayCalls).toEqual([]);
    expect(stored.runUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
    expect(stored.taskUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
  });

  it('入队失败后的清理再失败也不改变 429 响应', async () => {
    submitError = new QueueFullError('t1');
    runUpdateError = new Error('db down');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.payload)).toEqual({ error: 'queue_full' });
    expect(queueCalls).toHaveLength(1);
    expect(relayCalls).toEqual([]);
  });

  it('入队其他异常时同样标记失败并返回 500', async () => {
    submitError = new Error('redis down');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });

    expect(res.statusCode).toBe(500);
    expect(queueCalls).toHaveLength(1);
    expect(relayCalls).toEqual([]);
    expect(stored.runUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
    expect(stored.taskUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
  });

  it('挂接时 run 已被删除返回 404，不影响入队后的响应', async () => {
    attachError = new NotFoundException('run_not_found');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ error: 'run_not_found' });
    expect(queueCalls).toHaveLength(1);
  });

  it('附件预检在准入前拒绝不支持的模态，放行时把附件写入快照', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const headers = { authorization: `Bearer ${token}` };
    ownedAttachments = [
      {
        id: 'a1',
        kind: 'image',
        filename: 'p.png',
        mime: 'image/png',
        size: 3,
        storageKey: 'attachments/t1/u1/x/p.png',
      },
    ];

    selectedModalities = ['text'];
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers,
      payload: { goal: '', attachmentIds: ['a1'] },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(JSON.parse(unsupported.payload)).toEqual({
      error: 'model_modality_unsupported',
      model: 'mock',
      modalities: ['image'],
    });
    expect(billingCalls).toEqual([]);
    expect(stored.runCreates).toHaveLength(0);

    selectedModalities = ['text', 'image'];
    const ok = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ goal: '', attachmentIds: ['a1'] }),
    });
    expect(ok.status).toBe(200);
    await ok.text();
    // 纯附件消息是唯一的 user 消息，附件元数据随快照落库供执行器水合。
    const messages = finalTaskInput().messages;
    expect(messages.at(-1)?.attachments).toHaveLength(1);
    // 创建路径不读取附件字节。
    expect(attachmentCalls.some((c) => c[0] === 'hydrate')).toBe(false);
  });
});
