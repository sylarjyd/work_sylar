import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { KbController } from './kb.controller';
import { InternalKbController } from './internal-kb.controller';
import { KbService } from './kb.service';
import { KB_STORAGE } from './storage';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;

const created: Record<string, unknown>[] = [];
const deleted: string[] = [];
let searchBody: Record<string, unknown> | null = null;
let lookupFail = false;

const fakePrisma = {
  kbDoc: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'd1', chunkCount: 0, error: null, status: 'pending', createdAt: new Date('2026-01-01T00:00:00Z'), ...data };
      created.push(row);
      return row;
    },
    findMany: async () => [],
    findFirst: async ({ where }: { where: { id: string } }) => {
      if (lookupFail) throw new Error('db down');
      return where.id === 'd1' ? { id: 'd1' } : null;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      deleted.push(where.id);
      return {};
    },
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  },
  kbChunk: { deleteMany: async () => ({ count: 0 }) },
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakePrisma),
  $queryRaw: async () => [],
  $executeRaw: async () => 1,
} as unknown as PrismaService;

const fakeStorage = { putObject: async () => {} };

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.KB_MAX_FILE_BYTES = '1024';
  const moduleRef = await Test.createTestingModule({
    controllers: [KbController, InternalKbController],
    providers: [
      {
        provide: KbService,
        useFactory: () =>
          new KbService(fakePrisma, {
            runtimeUrl: 'http://runtime',
            fetchImpl: (async () => new Response(JSON.stringify({ ok: true, chunks: [] }), { status: 200 })) as unknown as typeof fetch,
          }),
      },
      { provide: KB_STORAGE, useValue: fakeStorage },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(multipart, { limits: { fileSize: Number(process.env.KB_MAX_FILE_BYTES) } });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  created.length = 0;
  deleted.length = 0;
  searchBody = null;
  lookupFail = false;
});

const token = () => signToken({ sub: 'u1', tenantId: 't1' });
const auth = () => ({ authorization: `Bearer ${token()}` });

function multipartForm(filename: string, content: string, type = 'text/plain') {
  const boundary = '----testboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${type}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('KbController', () => {
  it('未鉴权 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/kb/docs' });
    expect(res.statusCode).toBe(401);
  });

  it('上传 txt 返回 202 与 pending DTO', async () => {
    const form = multipartForm('a.txt', 'hello');
    const res = await app.inject({ method: 'POST', url: '/api/kb/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ filename: 'a.txt', status: 'pending' });
    expect(created).toHaveLength(1);
  });

  it('不支持的类型返回 400 unsupported_type', async () => {
    const form = multipartForm('a.exe', 'x', 'application/octet-stream');
    const res = await app.inject({ method: 'POST', url: '/api/kb/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported_type' });
  });

  it('超过 KB_MAX_FILE_BYTES 返回 413', async () => {
    const form = multipartForm('a.txt', 'x'.repeat(5000));
    const res = await app.inject({ method: 'POST', url: '/api/kb/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file_too_large' });
  });

  it('删除非本人文档 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/docs/other', headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'doc_not_found' });
  });

  it('删除本人文档 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/docs/d1', headers: auth() });
    expect(res.statusCode).toBe(204);
    expect(deleted).toEqual(['d1']);
  });

  it('归属查询故障时原样抛出（500），不伪装成 404', async () => {
    lookupFail = true;
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/docs/d1', headers: auth() });
    expect(res.statusCode).toBe(500);
  });
});

describe('InternalKbController', () => {
  it('token 不符 401', async () => {
    process.env.INTERNAL_TOKEN = 'sekret';
    try {
      const res = await app.inject({ method: 'POST', url: '/internal/kb/search', payload: { vector: [1], topK: 5, tenantId: 't1', userId: 'u1' } });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.INTERNAL_TOKEN;
    }
  });

  it('token 正确透传服务并返回命中数组', async () => {
    process.env.INTERNAL_TOKEN = 'sekret';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/kb/search',
        headers: { 'x-internal-token': 'sekret' },
        payload: { vector: [1, 0, 0], topK: 5, tenantId: 't1', userId: 'u1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      delete process.env.INTERNAL_TOKEN;
    }
  });

  it('未配置 INTERNAL_TOKEN 时仅放行回环来源（inject 即回环）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/kb/search',
      payload: { vector: [1], topK: 5, tenantId: 't1', userId: 'u1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('向量形状非法返回 400', async () => {
    for (const vector of [[], 'x', [1, 'a'], [1, null]]) {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/kb/search',
        payload: { vector, topK: 5, tenantId: 't1', userId: 'u1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_params' });
    }
  });

  it('tenant/user 缺失或非字符串返回 400', async () => {
    for (const payload of [{ vector: [1] }, { vector: [1], tenantId: 't1' }, { vector: [1], tenantId: 1, userId: 'u1' }]) {
      const res = await app.inject({ method: 'POST', url: '/internal/kb/search', payload });
      expect(res.statusCode).toBe(400);
    }
  });
});
