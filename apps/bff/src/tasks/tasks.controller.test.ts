import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { BaseExceptionFilter } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ArgumentsHost } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { encodeSse } from '@ai-office/shared';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { ArtifactService } from '../artifacts/artifacts.service';
import { ARTIFACT_STORAGE } from '../artifacts/storage';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';
import { BillingService } from '../billing/billing.service';
import { SettingsService } from '../settings/settings.service';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';

let upstream: Server;
let app: NestFastifyApplication;
let baseUrl: string;
let runtimeUrl: string;
// 上游收到的最近一次 /runs 请求体原文，供断言 BFF 透传的字段（如 userId）。
let lastRunsBody = '';
// 上游行为开关：正常流 / 中途发 error 事件 / 不发 usage / 慢速流（用于断连排空）/ 非 2xx。
let upstreamMode: 'ok' | 'error' | 'nousage' | 'slow' | 'fail502' = 'ok';
// 落库故障注入开关：用于验证控制器在写库失败时的落 failed / 不挂起行为。
// 这些开关必须能被各用例独立置位，否则「修复被回退」时用例依旧会通过。
let failStepCreate = false;
let failRunUpdate = false;
let failTaskCreate = false;
// 配置读取故障注入：非空时 getRunConfig 抛错，用于验证「配置失败不留预占/不建 task」。
let getRunConfigError: unknown = null;

const stored: {
  steps: unknown[];
  messages: unknown[];
  runUpdates: unknown[];
  taskUpdates: unknown[];
  artifacts: unknown[];
} = { steps: [], messages: [], runUpdates: [], taskUpdates: [], artifacts: [] };

const session = { id: 's1', tenantId: 't1', userId: 'u1', title: 'x', createdAt: new Date() };

// 计费调用记录与故障注入：用例据此断言预占/记录/结算/释放的顺序与结果。
const billingCalls: unknown[][] = [];
let beginRunError: unknown = null;
const fakeBilling = {
  beginRun: async (runId: string, tenantId: string) => {
    billingCalls.push(['begin', runId, tenantId]);
    if (beginRunError) throw beginRunError;
    return {
      maxCredits: 50,
      allowedModels: ['mock'],
      prices: { mock: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 } },
    };
  },
  recordUsage: async (...args: unknown[]) => {
    billingCalls.push(['record', ...args]);
  },
  settle: async (runId: string) => {
    billingCalls.push(['settle', runId]);
  },
  releaseHold: async (runId: string) => {
    billingCalls.push(['release', runId]);
  },
} as unknown as BillingService;

// 逃逸到 Nest 异常处理器的异常会被登记在这里。
// 存在的意义：Nest 的 BaseExceptionFilter 在 reply 已 hijack 时会兜底
// 调用 reply.raw.end()，因此「客户端是否挂起」无法区分 safeFinish 守卫是否在位；
// 真正能判别的信号是「落库异常有没有冒泡出控制器」。守卫在位 → 不冒泡；守卫被删
// → 异常冒泡到此数组，对应用例随即失败。
const escapedErrors: unknown[] = [];
class RecordingExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    escapedErrors.push(exception);
    super.catch(exception, host);
  }
}

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
  },
  message: {
    findMany: async () => [],
    findFirst: async () => null,
    count: async () => 1,
    create: async ({ data }: { data: unknown }) => {
      stored.messages.push(data);
      return data;
    },
  },
  task: {
    create: async ({ data }: { data: unknown }) => {
      if (failTaskCreate) throw new Error('injected task.create failure');
      return { id: 'task1', ...(data as object) };
    },
    update: async (args: unknown) => {
      stored.taskUpdates.push(args);
      return {};
    },
  },
  run: {
    create: async ({ data }: { data: unknown }) => ({ id: (data as { id?: string }).id ?? 'run1', ...(data as object) }),
    update: async (args: unknown) => {
      if (failRunUpdate) throw new Error('injected run.update failure');
      stored.runUpdates.push(args);
      return {};
    },
  },
  step: {
    create: async ({ data }: { data: unknown }) => {
      if (failStepCreate) throw new Error('injected step.create failure');
      stored.steps.push(data);
      return data;
    },
  },
  artifact: {
    aggregate: async () => ({ _max: { version: null } }),
    create: async ({ data }: { data: unknown }) => {
      stored.artifacts.push(data);
      return data;
    },
  },
  // 测试不需要事务隔离，直接把同一个 fake 交给回调。
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
} as unknown as PrismaService;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';

  upstream = createServer((req, res) => {
    // 读出请求体：供断言 BFF 把 userId 透传到 /runs（其余用例不读该变量）。
    let reqBody = '';
    req.on('data', (chunk) => (reqBody += chunk));
    req.on('end', () => {
      lastRunsBody = reqBody;
      // runId 由 BFF 预生成：上游事件与产物 storageKey 必须使用请求体里的真实值，
      // 否则 ArtifactService 的前缀校验会拒绝落库。
      const runId = (JSON.parse(reqBody) as { runId?: string }).runId ?? 'run1';
      if (upstreamMode === 'fail502') {
        // 非 2xx：控制器应释放预占、不结算，并把状态码与响应体原样回显。
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(encodeSse({ event: 'step', data: { runId, seq: 0, type: 'think', payload: { text: '想' }, ts: 1 } }));
      if (upstreamMode === 'error') {
        // 上游中途报错：控制器应把本次 run 记为 failed。
        res.write(encodeSse({ event: 'error', data: { message: 'boom' } }));
        res.end();
        return;
      }
      if (upstreamMode === 'nousage') {
        // 无 usage：控制器应只释放预占、不结算。
        res.write(encodeSse({ event: 'done', data: { runId } }));
        res.end();
        return;
      }
      if (upstreamMode === 'slow') {
        // 首帧已在上方写出；延迟发出 usage + done，给客户端留出中途断开的时间窗。
        setTimeout(() => {
          res.write(encodeSse({ event: 'usage', data: { input: 1, output: 1, models: [{ model: 'mock', input: 1, output: 1 }] } }));
          res.write(encodeSse({ event: 'done', data: { runId } }));
          res.end();
        }, 100);
        return;
      }
      res.write(encodeSse({ event: 'step', data: { runId, seq: 1, type: 'tool_call', payload: { tool: 'web.search' }, ts: 2 } }));
      res.write(encodeSse({ event: 'step', data: { runId, seq: 2, type: 'artifact', payload: { kind: 'pptx', filename: 'a.pptx', storageKey: `artifacts/t1/${runId}/x-a.pptx`, size: 3 }, ts: 3 } }));
      res.write(encodeSse({ event: 'usage', data: { input: 1, output: 1, models: [{ model: 'mock', input: 1, output: 1 }] } }));
      res.write(encodeSse({ event: 'done', data: { runId } }));
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  runtimeUrl = `http://127.0.0.1:${addr.port}`;
  process.env.AGENT_RUNTIME_URL = runtimeUrl;

  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController, TasksController],
    providers: [
      SessionsService,
      TasksService,
      ArtifactService,
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
      { provide: ARTIFACT_STORAGE, useValue: { getObjectStream: async () => { throw new Error('unused'); } } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // 记录逃逸异常（行为与内置 BaseExceptionFilter 一致，仅多一次登记）。
  app.useGlobalFilters(new RecordingExceptionFilter(app.getHttpAdapter()));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

beforeEach(() => {
  // stored 是模块级共享对象：不清空会让上一条用例的 step/message 泄进下一条，
  // 断言 toHaveLength(2) 会随执行顺序变成假阳性。
  stored.steps.length = 0;
  stored.messages.length = 0;
  stored.runUpdates.length = 0;
  stored.taskUpdates.length = 0;
  stored.artifacts.length = 0;
  // 恢复上游行为、注入开关与地址，避免用例间互相污染。
  upstreamMode = 'ok';
  failStepCreate = false;
  failRunUpdate = false;
  failTaskCreate = false;
  getRunConfigError = null;
  billingCalls.length = 0;
  beginRunError = null;
  escapedErrors.length = 0;
  lastRunsBody = '';
  process.env.AGENT_RUNTIME_URL = runtimeUrl;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('TasksController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('透传 SSE 且把 step 落库', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '查竞品' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: step');
    expect(text).toContain('event: done');
    // usage 透传但不落库
    expect(stored.steps).toHaveLength(3);
  });

  it('把 JWT 的 sub 作为 userId 透传给 runtime', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: '查一下' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(lastRunsBody).userId).toBe('u1');
    expect(JSON.parse(lastRunsBody).config).toEqual({
      maxRounds: 3,
      confirmTimeoutMs: 1000,
      codeExecTimeoutMs: 1234,
    });
  });

  it('SSE 里的 artifact step 触发产物落库', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '生成 PPT' }),
    });
    await res.text();
    expect(stored.artifacts).toHaveLength(1);
    expect(stored.artifacts[0]).toMatchObject({ filename: 'a.pptx', kind: 'pptx' });
  });

  it('流结束后把 assistant 消息（拼接的 think 文本）落库', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '查竞品' }),
    });
    await res.text();
    const assistant = stored.messages.find((m) => (m as { role?: string }).role === 'assistant');
    expect(assistant).toMatchObject({ role: 'assistant', content: '想' });
  });

  it('上游发 error 事件时 run/task 落 failed', async () => {
    upstreamMode = 'error';
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    await res.text();
    expect(stored.runUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
    expect(stored.taskUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
  });

  it('上游不可达时返回 502 且 run/task 落 failed', async () => {
    // 取一个刚关闭的空闲端口，连接必被拒绝 → fetch 抛错 → 传输层失败分支。
    const deadPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        probe.close(() => resolve(port));
      });
    });
    process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${deadPort}`;

    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_unreachable' });
    expect(stored.runUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
    expect(stored.taskUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
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
  });

  it('非本用户会话返回 404（hijack 必须晚于归属校验，否则请求挂起）', async () => {
    // s2 不在 fake store 里，assertOwned 抛 NotFoundException。
    // 走真实 socket：若控制器在校验前就 hijack，Nest 异常过滤器无法写响应，
    // 该请求将一直挂起（fetch 直到超时），拿不到 404。
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s2/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(404);
  });

  it('落库 step 抛错时把 run 记为 failed（非真空：删掉循环 catch 会记成 done）', async () => {
    // 让循环里的 recordStep 落库失败：读/解析/落库任一环抛错都必须把本次 run
    // 记为 failed。若控制器循环外没有 try/catch，控制流会带着初始的 'done'
    // 进 finally，run.update 便落成 'done'——本用例随即失败。
    failStepCreate = true;
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    await res.text();
    expect(stored.runUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
  });

  it('finish 落库失败也不挂起客户端（非真空：去掉 safeFinish 守卫会抛回 Nest）', async () => {
    // 让收尾的 run.update 抛错：safeFinish 必须吞掉异常，保证 reply.raw.end()
    // 无条件执行、响应照常终止。
    // 判别点不在「客户端是否挂起」：Nest 的 BaseExceptionFilter 在 reply 已 hijack
    // 时会兜底 end 掉响应，所以即便守卫被删，fetch 也照样会返回。真正的判别信号是
    // 落库异常有没有冒泡出控制器——守卫被回退成直接 await tasks.finish() 时，异常
    // 会逃逸到 Nest 异常处理器，被 RecordingExceptionFilter 记下，末尾断言随即失败。
    // AbortController 作兜底超时，防止任何意外挂起阻塞整个套件。
    failRunUpdate = true;
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ goal: 'g' }),
        signal: controller.signal,
      });
      const text = await res.text();
      // 响应体照常送达（含 step/done）说明请求已正常终止，没有挂起。
      expect(text).toContain('event: step');
      expect(text).toContain('event: done');
    } finally {
      clearTimeout(timer);
    }
    expect(escapedErrors).toHaveLength(0);
  });

  it('收到 usage 后记录并结算预占', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '写个总结' }),
    });
    await res.text();
    const begin = billingCalls.find((c) => c[0] === 'begin');
    const record = billingCalls.find((c) => c[0] === 'record');
    const settle = billingCalls.find((c) => c[0] === 'settle');
    expect(begin).toBeDefined();
    // record 的参数：runId 与 begin 一致；meta 与登录用户一致；usage 为上游事件内容。
    expect(record?.[1]).toBe(begin?.[1]);
    expect(record?.[2]).toEqual({ tenantId: 't1', userId: 'u1', sessionId: session.id });
    expect(record?.[3]).toEqual({ input: 1, output: 1, models: [{ model: 'mock', input: 1, output: 1 }] });
    expect(settle?.[1]).toBe(begin?.[1]);
  });

  it('prepare 失败时归还预占', async () => {
    // 预占成功后建 task 抛错：必须 release，不能记录/结算用量。
    failTaskCreate = true;
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(500);
    expect(billingCalls.some((c) => c[0] === 'release')).toBe(true);
    expect(billingCalls.some((c) => c[0] === 'record')).toBe(false);
    expect(billingCalls.some((c) => c[0] === 'settle')).toBe(false);
  });

  it('上游非 2xx 时释放预占且不结算', async () => {
    upstreamMode = 'fail502';
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'upstream_boom' });
    expect(billingCalls.some((c) => c[0] === 'release')).toBe(true);
    expect(billingCalls.some((c) => c[0] === 'record')).toBe(false);
    expect(billingCalls.some((c) => c[0] === 'settle')).toBe(false);
  });

  it('上游无 usage 时只释放预占', async () => {
    upstreamMode = 'nousage';
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '写个总结' }),
    });
    await res.text();
    expect(billingCalls.some((c) => c[0] === 'settle')).toBe(false);
    expect(billingCalls.some((c) => c[0] === 'release')).toBe(true);
  });

  it('读取运行参数失败时不预占、不建 task/run', async () => {
    getRunConfigError = new Error('injected settings failure');
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    // 配置读取发生在 hijack/BEGIN 之前，因此可以走 inject 拿到正常的 JSON 错误响应。
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(500);
    // 预占必须尚未发生（既无 begin 也无 release）。
    expect(billingCalls).toHaveLength(0);
    expect(stored.messages).toHaveLength(0);
    expect(stored.artifacts).toHaveLength(0);
    expect(lastRunsBody).toBe('');
  });

  it('可用积分不足返回 402', async () => {
    beginRunError = new InsufficientCreditsError();
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '写个总结' }),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'insufficient_credits' });
    // 预占失败发生在 hijack 之前，不应建 task/run。
    expect(stored.messages).toHaveLength(0);
  });

  it('套餐过期返回 402，限流返回 429', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    beginRunError = new PlanExpiredError();
    const r1 = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '写个总结' }),
    });
    expect(r1.status).toBe(402);
    expect(await r1.json()).toEqual({ error: 'plan_expired' });

    beginRunError = new RateLimitedError(30);
    const r2 = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '写个总结' }),
    });
    expect(r2.status).toBe(429);
    expect(r2.headers.get('retry-after')).toBe('30');
    expect(await r2.json()).toEqual({ error: 'rate_limited', retryAfter: 30 });
  });

  it('客户端断开后仍继续排空上游并结算', async () => {
    upstreamMode = 'slow';
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '长任务' }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // 至少收到首帧后再断开
    ac.abort();
    // 排空是异步的：用轮询等待结算，避免固定 sleep 在慢机器上偶发假失败。
    await vi.waitFor(() => expect(billingCalls.some((c) => c[0] === 'settle')).toBe(true), { timeout: 2000 });
  });
});
