import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const tenantId = 't1';
const userId = 'u1';
let token: string;

// 内存假库：会话归属用 tenantId/userId 过滤，模拟行级隔离。
const sessions: { id: string; tenantId: string; userId: string; title: string; createdAt: Date }[] = [];
const messages: { id: string; sessionId: string; role: string; content: string; seq: number }[] = [];

// 单调递增，跨 beforeEach 不重置，贴近真实自增主键（否则 id 会随 fake 重置而复用）。
let seq = 0;

const fakePrisma = {
  session: {
    findMany: async ({ where }: { where: { tenantId: string; userId: string } }) =>
      sessions.filter((s) => s.tenantId === where.tenantId && s.userId === where.userId),
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      sessions.find(
        (s) => s.id === where.id && s.tenantId === where.tenantId && s.userId === where.userId,
      ) ?? null,
    create: async ({ data }: { data: { tenantId: string; userId: string; title: string } }) => {
      const row = { id: `s${++seq}`, createdAt: new Date(), ...data };
      sessions.push(row);
      return row;
    },
  },
  message: {
    findMany: async ({ where }: { where: { sessionId: string } }) =>
      messages.filter((m) => m.sessionId === where.sessionId).sort((a, b) => a.seq - b.seq),
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  token = signToken({ sub: userId, tenantId });
  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController],
    providers: [SessionsService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  sessions.length = 0;
  messages.length = 0;
});

// token 在 beforeAll 才签发，故用函数惰性取值，避免模块求值时捕获到 undefined。
const auth = () => ({ authorization: `Bearer ${token}` });

describe('SessionsController', () => {
  it('未带 token 访问返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('创建后可列出会话', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: auth(),
      payload: { title: '第一个会话' },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth() });
    const arr = JSON.parse(list.payload);
    expect(arr).toHaveLength(1);
    expect(arr[0].title).toBe('第一个会话');
  });

  it('可读取自己会话的消息，且按 seq 升序', async () => {
    sessions.push({ id: 's9', tenantId, userId, title: 'x', createdAt: new Date() });
    messages.push(
      { id: 'm2', sessionId: 's9', role: 'assistant', content: 'b', seq: 1 },
      { id: 'm1', sessionId: 's9', role: 'user', content: 'a', seq: 0 },
    );
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s9/messages', headers: auth() });
    expect(res.statusCode).toBe(200);
    const arr = JSON.parse(res.payload);
    expect(arr.map((m: { seq: number }) => m.seq)).toEqual([0, 1]);
  });

  it('省略 title 时创建会话使用默认标题', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).title).toBe('新会话');
  });

  it('跨租户访问他人会话返回 404', async () => {
    // 先落库一个确属 u1/t1 的会话：下面别的用户拿到 404 必须是「归属不匹配」而非「会话不存在」，
    // 否则用例无法区分存在性与归属，断言会退化成空集检查。
    sessions.push({ id: 's-owned', tenantId, userId, title: 'owned', createdAt: new Date() });

    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const denied = await app.inject({
      method: 'GET',
      url: '/api/sessions/s-owned/messages',
      headers: { authorization: `Bearer ${other}` },
    });
    expect(denied.statusCode).toBe(404);

    // 同一会话由属主读取应当成功，证明确实存在且归属过滤生效。
    const owned = await app.inject({
      method: 'GET',
      url: '/api/sessions/s-owned/messages',
      headers: auth(),
    });
    expect(owned.statusCode).toBe(200);
    expect(JSON.parse(owned.payload)).toEqual([]);
  });
});
