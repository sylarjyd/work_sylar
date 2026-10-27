import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../db/prisma.service';
import { QaCacheService } from '../qa-cache/qa-cache.service';
import { signToken } from '../auth/jwt';
import { AdminQaCacheController } from './admin-qa-cache.controller';
import { AdminQaCacheService } from './admin-qa-cache.service';

const HASH = 'a'.repeat(64);
const entry = {
  hash: HASH,
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  question: '写个总结',
  answer: '这是答案',
  createdAt: Date.parse('2026-10-27T00:00:00Z'),
  expiresAt: Date.parse('2026-10-27T00:05:00Z'),
};

const auditRows: Array<Record<string, unknown>> = [];

/** 会话查询结果可替换，便于模拟会话存在但 user 关系为空的行。 */
let sessionRows: Array<{ id: string; title: string; user: { email: string } | null }> = [];
const defaultSessionRows = () => [
  { id: 's1', title: '缓存会话', user: { email: 'user1@test.local' } },
];

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'admin' ? 'admin' : 'member',
      tenantId: 't1',
      email: `${where.id}@test.local`,
    }),
  },
  session: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      sessionRows.filter((row) => where.id.in.includes(row.id)),
  },
  adminAuditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push(data);
      return {};
    },
  },
} as unknown as PrismaService;

const qaCache = {
  list: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
};

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminQaCacheController],
    providers: [
      AdminQaCacheService,
      AuditService,
      { provide: PrismaService, useValue: fakePrisma },
      { provide: QaCacheService, useValue: qaCache },
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
  auditRows.length = 0;
  sessionRows = defaultSessionRows();
  qaCache.list.mockReset().mockResolvedValue({ items: [entry], total: 1 });
  qaCache.get.mockReset().mockResolvedValue(entry);
  qaCache.remove.mockReset().mockResolvedValue(undefined);
});

const auth = (sub: string) => ({
  authorization: `Bearer ${signToken({ sub, tenantId: 't1' })}`,
});

describe('问答缓存接口', () => {
  it('普通成员访问列表与删除均返回 403', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache',
      headers: auth('u1'),
    });
    expect(list.statusCode).toBe(403);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/admin/qa-cache/${HASH}`,
      headers: auth('u1'),
    });
    expect(remove.statusCode).toBe(403);
  });

  it('列表补充会话名称与用户名称，并透出问题、答案与过期时间', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache',
      headers: auth('admin'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as {
      items: Array<Record<string, unknown>>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(body.items[0]).toMatchObject({
      hash: HASH,
      userEmail: 'user1@test.local',
      sessionTitle: '缓存会话',
      question: '写个总结',
      answer: '这是答案',
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    });

    expect(auditRows[0]).toMatchObject({
      action: 'qa_cache.list',
      targetType: 'qa_cache',
    });
    // 审计只记分页与条数，绝不能带出问答正文。
    expect(auditRows[0].summary).toEqual({ page: 1, pageSize: 20, count: 1 });
  });

  it('会话存在但 user 关系为空时回退展示用户 id', async () => {
    sessionRows = [{ id: 's1', title: '缓存会话', user: null }];

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache',
      headers: auth('admin'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      userEmail: 'u1',
      sessionTitle: '缓存会话',
    });
  });

  it('会话或用户缺失时回退展示原始 id', async () => {
    qaCache.list.mockResolvedValue({
      items: [{ ...entry, sessionId: 's404', userId: 'u404' }],
      total: 1,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache',
      headers: auth('admin'),
    });

    const body = JSON.parse(res.payload) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ userEmail: 'u404', sessionTitle: 's404' });
  });

  it('分页参数越界返回 400', async () => {
    const badPage = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache?page=0',
      headers: auth('admin'),
    });
    expect(badPage.statusCode).toBe(400);
    expect(JSON.parse(badPage.payload)).toMatchObject({ message: 'invalid_page' });

    const badSize = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache?pageSize=101',
      headers: auth('admin'),
    });
    expect(badSize.statusCode).toBe(400);
    expect(JSON.parse(badSize.payload)).toMatchObject({ message: 'invalid_page_size' });
  });

  it('删除条目写审计并返回 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/qa-cache/${HASH}`,
      headers: auth('admin'),
    });

    expect(res.statusCode).toBe(204);
    expect(qaCache.remove).toHaveBeenCalledWith(HASH);
    expect(auditRows[0]).toMatchObject({
      action: 'qa_cache.delete',
      targetType: 'qa_cache',
      targetId: HASH,
    });
    expect(auditRows[0].summary).toEqual({ userId: 'u1', sessionId: 's1' });
  });

  it('删除已过期或不存在的 hash 仍返回 204 并写审计', async () => {
    qaCache.get.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/qa-cache/${HASH}`,
      headers: auth('admin'),
    });

    expect(res.statusCode).toBe(204);
    expect(qaCache.remove).toHaveBeenCalledWith(HASH);
    expect(auditRows[0].summary).toEqual({ userId: null, sessionId: null });
  });

  it('非法 hash 返回 400 invalid_hash，且不触碰缓存', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/qa-cache/not-a-hash',
      headers: auth('admin'),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ message: 'invalid_hash' });
    expect(qaCache.get).not.toHaveBeenCalled();
    expect(qaCache.remove).not.toHaveBeenCalled();
  });

  it('删除时缓存普通错误也转成 503 cache_unavailable', async () => {
    qaCache.remove.mockRejectedValueOnce(new Error('connection lost'));
    const removeFailed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/qa-cache/${HASH}`,
      headers: auth('admin'),
    });
    expect(removeFailed.statusCode).toBe(503);
    expect(JSON.parse(removeFailed.payload)).toMatchObject({ message: 'cache_unavailable' });

    qaCache.get.mockRejectedValueOnce(new Error('connection lost'));
    const getFailed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/qa-cache/${HASH}`,
      headers: auth('admin'),
    });
    expect(getFailed.statusCode).toBe(503);
    expect(JSON.parse(getFailed.payload)).toMatchObject({ message: 'cache_unavailable' });
  });

  it('缓存命令失败时列表与删除都返回 503 cache_unavailable', async () => {
    qaCache.list.mockRejectedValue(new Error('connection lost'));
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/qa-cache',
      headers: auth('admin'),
    });
    expect(list.statusCode).toBe(503);
    expect(JSON.parse(list.payload)).toMatchObject({ message: 'cache_unavailable' });

    qaCache.get.mockRejectedValue(new ServiceUnavailableException('cache_unavailable'));
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/admin/qa-cache/${HASH}`,
      headers: auth('admin'),
    });
    expect(remove.statusCode).toBe(503);
    expect(JSON.parse(remove.payload)).toMatchObject({ message: 'cache_unavailable' });
  });
});
