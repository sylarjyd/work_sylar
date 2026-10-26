import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from '../sessions/sessions.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { PrismaService } from '../db/prisma.service';
import { RunRelayService } from '../queue/run-relay.service';
import { QueueFullError } from '../queue/run-queue.service';
import { RUN_CONTROL_BUS } from '../queue/queue.tokens';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;
let prismaFail = false;
/** 控制总线发布桩：确认端点只验证据此下发决策，不再直连 runtime。 */
const publishControl = vi.fn().mockResolvedValue(undefined);

// 归属：仅 r1 属 t1/u1；嵌套关系过滤由假库按 where 结构模拟。
const ownedRun = { id: 'r1' };
/** 流式挂接以桩替代：本文件只验证路由、鉴权与游标解析。 */
const attach = vi.fn(async (_runId: string, reply: FastifyReply) => {
  reply.status(200).header('content-type', 'text/plain').send('ok');
});
/** 取消服务桩：按用例切换返回值或异常；所有权校验由 RunsService 单元测试覆盖。 */
let cancelResult: { status: string } = { status: 'canceled' };
let cancelError: unknown;
const cancel = vi.fn(async () => {
  if (cancelError) throw cancelError;
  return cancelResult;
});
/** 重试服务桩：本文件只验证 HTTP 状态/错误码映射。 */
let retryResult: { runId: string; taskId: string; attempt: number } = {
  runId: 'r2',
  taskId: 'task1',
  attempt: 2,
};
let retryError: unknown;
const retry = vi.fn(async () => {
  if (retryError) throw retryError;
  return retryResult;
});
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
  run: {
    findFirst: async ({
      where,
    }: {
      where: { id: string; task?: { session?: { tenantId?: string; userId?: string } } };
    }) => {
      if (prismaFail) throw new Error('db down');
      const s = where.task?.session;
      return where.id === ownedRun.id && s?.tenantId === 't1' && s?.userId === 'u1'
        ? { id: 'r1' }
        : null;
    },
  },
} as unknown as PrismaService;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';

  const moduleRef = await Test.createTestingModule({
    controllers: [RunsController],
    providers: [
      TasksService,
      SessionsService,
      { provide: PrismaService, useValue: fakePrisma },
      // SessionsService 依赖模型目录；本文件只验证 run 归属，给一个不会被调用的桩。
      { provide: ModelCatalogService, useValue: { available: async () => ({ models: [], defaultModel: null }) } },
      { provide: RunRelayService, useValue: { attach } },
      { provide: RunsService, useValue: { cancel, retry } },
      { provide: RUN_CONTROL_BUS, useValue: { publish: publishControl } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

beforeEach(() => {
  prismaFail = false;
  cancelResult = { status: 'canceled' };
  cancelError = undefined;
  cancel.mockClear();
  retryResult = { runId: 'r2', taskId: 'task1', attempt: 2 };
  retryError = undefined;
  retry.mockClear();
  attach.mockClear();
  publishControl.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await app.close();
});

const token = () => signToken({ sub: 'u1', tenantId: 't1' });
const auth = () => ({ authorization: `Bearer ${token()}` });

describe('RunsController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(401);
    expect(publishControl).not.toHaveBeenCalled();
  });

  it('非本用户的 run 返回 404 且不发布控制消息', async () => {
    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: { authorization: `Bearer ${other}` },
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(404);
    expect(publishControl).not.toHaveBeenCalled();
  });

  it('归属查询故障时原样抛出（500），不伪装成 404', async () => {
    prismaFail = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: auth(),
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(500);
    expect(publishControl).not.toHaveBeenCalled();
  });

  it('stream：非本用户的 run 返回 404 且不挂接', async () => {
    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/r1/stream',
      headers: { authorization: `Bearer ${other}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'run_not_found' });
    expect(attach).not.toHaveBeenCalled();
  });

  it('stream：Last-Event-ID 优先于 query（重连时 header 更新）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/r1/stream?afterSeq=5',
      headers: { ...auth(), 'last-event-id': '7' },
    });
    expect(res.statusCode).toBe(200);
    expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: 7 });
  });

  it('stream：无 header 时使用 query 游标', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/r1/stream?afterSeq=5',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: 5 });
  });

  it('stream：非法 header 回退 -1，不回落到 query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/r1/stream?afterSeq=5',
      headers: { ...auth(), 'last-event-id': 'abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: -1 });
  });

  it('stream：空/空白/非法游标回退为 -1', async () => {
    // 空 query 会被 Number('') 解析成 0，绝不能当成 from 0（会漏掉 seq 0）。
    for (const url of [
      '/api/runs/r1/stream?afterSeq=',
      '/api/runs/r1/stream?afterSeq=%20',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: -1 });
    }

    for (const bad of ['abc', '-5', '1.5', 'NaN']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/r1/stream?afterSeq=${bad}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: -1 });
    }
  });

  it('stream：合法游标（含 -1 与 0）原样透传', async () => {
    for (const [cursor, expected] of [
      ['-1', -1],
      ['0', 0],
      ['12', 12],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/r1/stream?afterSeq=${cursor}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: expected });
    }
  });

  it('body 非法返回 400 且不发布控制消息', async () => {
    for (const payload of [{}, { confirmId: '', approved: true }, { confirmId: 'c1', approved: 'x' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs/r1/confirm',
        headers: auth(),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_decision' });
    }
    expect(publishControl).not.toHaveBeenCalled();
  });

  it('confirmId 仅含空白时返回 400 且不发布控制消息', async () => {
    // 空白串 trim 后为空：若不拒绝会下发一个永远匹配不到的决策，只能等 runtime 超时。
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: auth(),
      payload: { confirmId: '   ', approved: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_decision' });
    expect(publishControl).not.toHaveBeenCalled();
  });

  it('合法请求经控制总线下发决策并返回 ok，不直连 runtime', async () => {
    // 全局 fetch 只应在执行器转发时使用；控制器绝不能自己打到 runtime。
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs/r1/confirm',
        headers: auth(),
        payload: { confirmId: 'c1', approved: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(publishControl).toHaveBeenCalledWith('r1', {
        type: 'confirm',
        confirmId: 'c1',
        approved: true,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('发布控制消息失败时返回 500（决策未送达，客户端应看到错误）', async () => {
    publishControl.mockRejectedValueOnce(new Error('redis down'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: auth(),
      payload: { confirmId: 'c1', approved: false },
    });
    expect(res.statusCode).toBe(500);
  });

  it('cancel：调用服务并回 200 JSON 结果', async () => {
    cancelResult = { status: 'running' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/cancel',
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'running' });
    expect(cancel).toHaveBeenCalledWith('r1', 't1', 'u1');
  });

  it('cancel：run 不存在或非本人时映射为 404 run_not_found', async () => {
    cancelError = new NotFoundException('run_not_found');
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/cancel',
      headers: auth(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'run_not_found' });
  });

  it('retry：成功时返回 202 与新运行信息', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/retry',
      headers: auth(),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: 'r2', taskId: 'task1', attempt: 2 });
    expect(retry).toHaveBeenCalledWith('r1', 't1', 'u1');
  });

  it('retry：run 不存在或非本人时映射为 404 run_not_found', async () => {
    retryError = new NotFoundException('run_not_found');
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/retry',
      headers: auth(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'run_not_found' });
  });

  it('retry：白名单内的冲突码映射为 409', async () => {
    for (const code of [
      'run_not_retryable',
      'task_snapshot_missing',
      'task_busy',
      'task_not_retryable',
    ]) {
      retryError = new ConflictException(code);
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs/r1/retry',
        headers: auth(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: code });
    }
  });

  it('retry：白名单外的冲突码不按业务码透出，交给默认异常体处理', async () => {
    retryError = new ConflictException('internal_conflict');
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/retry',
      headers: auth(),
    });

    // 未知码不能变成稳定的对外契约 `{error:<code>}`；重新抛出后由默认过滤器渲染。
    expect(res.statusCode).toBe(409);
    expect(res.json()).not.toEqual({ error: 'internal_conflict' });
  });

  it('retry：队列已满映射为 429 queue_full', async () => {
    retryError = new QueueFullError('t1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/retry',
      headers: auth(),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'queue_full' });
  });

  it('retry：其它异常返回 500', async () => {
    retryError = new Error('db down');
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/retry',
      headers: auth(),
    });

    expect(res.statusCode).toBe(500);
  });
});
