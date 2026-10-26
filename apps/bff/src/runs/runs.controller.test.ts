import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { createServer, type Server } from 'node:http';
import { RunsController } from './runs.controller';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from '../sessions/sessions.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { PrismaService } from '../db/prisma.service';
import { RunRelayService } from '../queue/run-relay.service';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;
let upstream: Server;
let runtimeUrl: string;
let upstreamStatus = 200;
let upstreamBody = JSON.stringify({ ok: true, matched: true });
let prismaFail = false;

// 归属：仅 r1 属 t1/u1；嵌套关系过滤由假库按 where 结构模拟。
const ownedRun = { id: 'r1' };
/** 流式挂接以桩替代：本文件只验证路由、鉴权与游标解析。 */
const attach = vi.fn(async (_runId: string, reply: FastifyReply) => {
  reply.status(200).header('content-type', 'text/plain').send('ok');
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

  upstream = createServer((_req, res) => {
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(upstreamBody);
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  runtimeUrl = `http://127.0.0.1:${addr.port}`;
  process.env.AGENT_RUNTIME_URL = runtimeUrl;

  const moduleRef = await Test.createTestingModule({
    controllers: [RunsController],
    providers: [
      TasksService,
      SessionsService,
      { provide: PrismaService, useValue: fakePrisma },
      // SessionsService 依赖模型目录；本文件只验证 run 归属，给一个不会被调用的桩。
      { provide: ModelCatalogService, useValue: { available: async () => ({ models: [], defaultModel: null }) } },
      { provide: RunRelayService, useValue: { attach } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

beforeEach(() => {
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ ok: true, matched: true });
  prismaFail = false;
  attach.mockClear();
  delete process.env.AGENT_RUNTIME_TOKEN;
  process.env.AGENT_RUNTIME_URL = runtimeUrl;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
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
  });

  it('非本用户的 run 返回 404', async () => {
    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: { authorization: `Bearer ${other}` },
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(404);
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

  it('stream：query 优先于 Last-Event-ID，非法游标回退为 -1', async () => {
    const query = await app.inject({
      method: 'GET',
      url: '/api/runs/r1/stream?afterSeq=5',
      headers: { ...auth(), 'last-event-id': '3' },
    });
    expect(query.statusCode).toBe(200);
    expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: 5 });

    const header = await app.inject({
      method: 'GET',
      url: '/api/runs/r1/stream',
      headers: { ...auth(), 'last-event-id': '7' },
    });
    expect(header.statusCode).toBe(200);
    expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: 7 });

    for (const bad of ['abc', '-5', '1.5']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/r1/stream?afterSeq=${bad}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(attach).toHaveBeenLastCalledWith('r1', expect.anything(), { afterSeq: -1 });
    }
  });

  it('body 非法返回 400（不转发上游）', async () => {
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
  });

  it('合法请求转发上游并回传其 200 结果', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: auth(),
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, matched: true });
  });

  it('上游非 2xx 时透传其状态码', async () => {
    upstreamStatus = 500;
    upstreamBody = JSON.stringify({ error: 'boom' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: auth(),
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(500);
  });

  it('上游不可达返回 502', async () => {
    const deadPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const port = typeof a === 'object' && a ? a.port : 0;
        probe.close(() => resolve(port));
      });
    });
    process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${deadPort}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/confirm',
      headers: auth(),
      payload: { confirmId: 'c1', approved: true },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_unreachable' });
  });
});
