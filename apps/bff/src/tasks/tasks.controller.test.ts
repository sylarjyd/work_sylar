import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, type Server } from 'node:http';
import { encodeSse } from '@ai-office/shared';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

let upstream: Server;
let app: NestFastifyApplication;
let baseUrl: string;
const stored: { steps: unknown[]; messages: unknown[] } = { steps: [], messages: [] };

const session = { id: 's1', tenantId: 't1', userId: 'u1', title: 'x', createdAt: new Date() };

const fakePrisma = {
  session: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      where.id === session.id && where.tenantId === session.tenantId && where.userId === session.userId
        ? session
        : null,
  },
  message: {
    findMany: async () => [],
    count: async () => 1,
    create: async ({ data }: { data: unknown }) => {
      stored.messages.push(data);
      return data;
    },
  },
  task: { create: async ({ data }: { data: unknown }) => ({ id: 'task1', ...(data as object) }), update: async () => ({}) },
  run: { create: async ({ data }: { data: unknown }) => ({ id: 'run1', ...(data as object) }), update: async () => ({}) },
  step: {
    create: async ({ data }: { data: unknown }) => {
      stored.steps.push(data);
      return data;
    },
  },
} as unknown as PrismaService;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';

  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSse({ event: 'step', data: { runId: 'run1', seq: 0, type: 'think', payload: { text: '想' }, ts: 1 } }));
    res.write(encodeSse({ event: 'step', data: { runId: 'run1', seq: 1, type: 'tool_call', payload: { tool: 'web.search' }, ts: 2 } }));
    res.write(encodeSse({ event: 'usage', data: { input: 1, output: 1 } }));
    res.write(encodeSse({ event: 'done', data: { runId: 'run1' } }));
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${addr.port}`;

  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController, TasksController],
    providers: [
      SessionsService,
      TasksService,
      { provide: PrismaService, useValue: fakePrisma },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
    expect(stored.steps).toHaveLength(2);
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
});
