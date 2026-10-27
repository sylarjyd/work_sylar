import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const tenantId = 't1';
const userId = 'u1';
let token: string;

// 内存假库：会话归属用 tenantId/userId 过滤，模拟行级隔离。
const sessions: {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  createdAt: Date;
  status?: string;
  titleSource?: string;
  pinned?: boolean;
}[] = [];
const tasks: { id: string; sessionId: string; status: string }[] = [];
const isActive = (s: { status?: string }) => (s.status ?? 'active') === 'active';
const messages: {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  seq: number;
  attachments?: {
    id: string;
    kind: string;
    filename: string;
    mime: string;
    size: number;
    storageKey: string;
  }[];
}[] = [];

// 单调递增，跨 beforeEach 不重置，贴近真实自增主键（否则 id 会随 fake 重置而复用）。
let seq = 0;

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
    findMany: async ({
      where,
      take,
      cursor,
      skip,
    }: {
      where: { tenantId: string; userId: string };
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      let list = sessions
        .filter(
          (s) => s.tenantId === where.tenantId && s.userId === where.userId && isActive(s),
        )
        .sort(
          (a, b) =>
            Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
      if (cursor) {
        const at = list.findIndex((s) => s.id === cursor.id);
        if (at >= 0) list = list.slice(at + (skip ?? 0));
      }
      if (take !== undefined) list = list.slice(0, take);
      return list;
    },
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      sessions.find(
        (s) =>
          s.id === where.id &&
          s.tenantId === where.tenantId &&
          s.userId === where.userId &&
          isActive(s),
      ) ?? null,
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; tenantId: string; userId: string };
      data: Record<string, unknown>;
    }) => {
      const row = sessions.find(
        (s) =>
          s.id === where.id &&
          s.tenantId === where.tenantId &&
          s.userId === where.userId &&
          isActive(s),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    create: async ({ data }: { data: { tenantId: string; userId: string; title: string } }) => {
      const row = {
        id: `s${++seq}`,
        createdAt: new Date(),
        status: 'active',
        titleSource: 'auto',
        pinned: false,
        ...data,
      };
      sessions.push(row);
      return row;
    },
  },
  task: {
    findFirst: async ({ where }: { where: { sessionId: string; status: { in: string[] } } }) =>
      tasks.find(
        (t) => t.sessionId === where.sessionId && where.status.in.includes(t.status),
      ) ?? null,
  },
  run: {
    // 本文件只验证路由与鉴权，运行标记一律为空；缺这个委托会让 activeRun 查询抛错刷 warn。
    findMany: async () => [],
  },
  message: {
    findMany: async ({ where }: { where: { sessionId: string } }) =>
      messages
        .filter((m) => m.sessionId === where.sessionId)
        .sort((a, b) => a.seq - b.seq)
        .map((m) => ({ attachments: [], ...m })),
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  token = signToken({ sub: userId, tenantId });
  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController],
    providers: [
      SessionsService,
      { provide: PrismaService, useValue: fakePrisma },
      {
        provide: ModelCatalogService,
        useValue: {
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
        },
      },
    ],
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
  tasks.length = 0;
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
    const page = JSON.parse(list.payload);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].title).toBe('第一个会话');
    expect(page.nextCursor).toBeNull();
  });

  it('按 limit 分页并可用 cursor 续拉', async () => {
    // createdAt 拉开展示顺序，避免同毫秒导致断言不稳定。
    for (let i = 0; i < 3; i++) {
      sessions.push({
        id: `p${i}`,
        tenantId,
        userId,
        title: `第 ${i} 个`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const first = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/sessions?limit=2', headers: auth() })).payload,
    );
    expect(first.items.map((s: { id: string }) => s.id)).toEqual(['p2', 'p1']);
    expect(first.nextCursor).toBe('p1');

    const next = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions?limit=2&cursor=${first.nextCursor}`,
          headers: auth(),
        })
      ).payload,
    );
    expect(next.items.map((s: { id: string }) => s.id)).toEqual(['p0']);
    expect(next.nextCursor).toBeNull();
  });

  it('可读取指定会话摘要，他人会话返回 404', async () => {
    sessions.push({ id: 'p-owned', tenantId, userId, title: '归属会话', createdAt: new Date() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/p-owned',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).title).toBe('归属会话');

    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const denied = await app.inject({
      method: 'GET',
      url: '/api/sessions/p-owned',
      headers: { authorization: `Bearer ${other}` },
    });
    expect(denied.statusCode).toBe(404);
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

  it('可重命名会话，标题来源转为 manual', async () => {
    sessions.push({ id: 's-rename', tenantId, userId, title: '旧标题', createdAt: new Date() });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s-rename',
      headers: auth(),
      payload: { title: '  新标题  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).title).toBe('新标题');
    expect(sessions[0]).toMatchObject({ title: '新标题', titleSource: 'manual' });
  });

  it('置顶后列表把会话排在最前', async () => {
    sessions.push(
      { id: 's-new', tenantId, userId, title: '新', createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 's-old', tenantId, userId, title: '旧', createdAt: new Date('2026-01-01T00:00:00Z') },
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s-old',
      headers: auth(),
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).pinned).toBe(true);
    const list = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/sessions', headers: auth() })).payload,
    );
    expect(list.items.map((s: { id: string }) => s.id)).toEqual(['s-old', 's-new']);
  });

  it('标题为空返回 400，他人会话返回 404', async () => {
    sessions.push({ id: 's-bad', tenantId, userId, title: 'x', createdAt: new Date() });
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s-bad',
      headers: auth(),
      payload: { title: '   ' },
    });
    expect(bad.statusCode).toBe(400);

    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/s-bad',
      headers: { authorization: `Bearer ${other}` },
      payload: { title: '偷改' },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('删除返回 204，之后列表与详情都不可见', async () => {
    sessions.push({ id: 's-del', tenantId, userId, title: '待删', createdAt: new Date() });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/s-del',
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(sessions[0].status).toBe('deleted');
    const list = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/sessions', headers: auth() })).payload,
    );
    expect(list.items).toEqual([]);
    const detail = await app.inject({
      method: 'GET',
      url: '/api/sessions/s-del',
      headers: auth(),
    });
    expect(detail.statusCode).toBe(404);
  });

  it('会话有运行中任务时删除返回 409', async () => {
    sessions.push({ id: 's-busy', tenantId, userId, title: '忙', createdAt: new Date() });
    tasks.push({ id: 'task-1', sessionId: 's-busy', status: 'running' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/s-busy',
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(isActive(sessions[0])).toBe(true);
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
