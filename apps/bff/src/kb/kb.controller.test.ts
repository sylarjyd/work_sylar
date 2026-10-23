import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { KbController } from './kb.controller';
import { InternalKbController } from './internal-kb.controller';
import { KbService } from './kb.service';
import { KB_STORAGE } from './storage';
import { PrismaService } from '../db/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;

const created: Record<string, unknown>[] = [];
const deletedDocs: string[] = [];
const deletedBases: string[] = [];
const deletedObjects: string[][] = [];
const execCalls: { sql: string; values: unknown[] }[] = [];
let lookupFail = false;
// 非 null 时 SettingsService 桩的 getKbConfig 抛该错误，用于验证上传关键路径的降级。
let kbConfigError: unknown = null;

const baseRows = [
  {
    id: 'b1',
    tenantId: 't1',
    userId: 'u1',
    name: '默认知识库',
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'b2',
    tenantId: 't2',
    userId: 'u2',
    name: '他人知识库',
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
];

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
  knowledgeBase: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      if (lookupFail) throw new Error('db down');
      return (
        baseRows.find(
          (b) =>
            b.id === where.id &&
            (where.tenantId === undefined || b.tenantId === where.tenantId) &&
            (where.userId === undefined || b.userId === where.userId),
        ) ?? null
      );
    },
    findMany: async () => baseRows,
    create: async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'b9',
      description: '',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...data,
    }),
    update: async ({ data }: { data: Record<string, unknown> }) => ({
      ...baseRows[0],
      ...data,
    }),
    delete: async ({ where }: { where: { id: string } }) => {
      deletedBases.push(where.id);
      return {};
    },
  },
  kbDoc: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'd1', chunkCount: 0, error: null, status: 'pending', createdAt: new Date('2026-01-01T00:00:00Z'), ...data };
      created.push(row);
      return row;
    },
    findMany: async () => [{ storageKey: 'kb/t1/u1/b1/x/a.txt' }],
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      if (lookupFail) throw new Error('db down');
      if (where.id === 'd1' && where.knowledgeBaseId === 'b1') {
        return { id: 'd1', filename: 'a.txt', storageKey: 'kb/t1/u1/b1/x/a.txt' };
      }
      return null;
    },
    groupBy: async () => [],
    delete: async ({ where }: { where: { id: string } }) => {
      deletedDocs.push(where.id);
      return {};
    },
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  },
  kbChunk: { deleteMany: async () => ({ count: 0 }) },
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakePrisma),
  $queryRaw: async () => [],
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execCalls.push({ sql: strings.join('?'), values });
    return 1;
  },
} as unknown as PrismaService;

const fakeStorage = {
  putObject: async () => {},
  deleteObject: async () => {},
  deleteObjects: async (keys: string[]) => {
    deletedObjects.push(keys);
    return [];
  },
};

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
      {
        provide: SettingsService,
        useValue: {
          getKbConfig: async () => {
            if (kbConfigError) throw kbConfigError;
            return { chunkSize: 600, chunkOverlap: 100 };
          },
        },
      },
      // JwtGuard 依赖 PrismaService 查库，需与 useFactory 的 KbService 共用同一假库。
      { provide: PrismaService, useValue: fakePrisma },
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
  deletedDocs.length = 0;
  deletedBases.length = 0;
  deletedObjects.length = 0;
  execCalls.length = 0;
  lookupFail = false;
  kbConfigError = null;
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

describe('KbController（知识库）', () => {
  it('未鉴权 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/kb/bases' });
    expect(res.statusCode).toBe(401);
  });

  it('创建知识库返回 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kb/bases',
      headers: auth(),
      payload: { name: '合同库', description: '合同模板' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: '合同库', description: '合同模板' });
  });

  it('上传 txt 到知识库返回 202 与 pending DTO', async () => {
    const form = multipartForm('a.txt', 'hello');
    const res = await app.inject({ method: 'POST', url: '/api/kb/bases/b1/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ filename: 'a.txt', status: 'pending', knowledgeBaseId: 'b1' });
    expect(created).toHaveLength(1);
  });

  it('上传到他人知识库 404 且不建文档', async () => {
    const form = multipartForm('a.txt', 'hello');
    const res = await app.inject({ method: 'POST', url: '/api/kb/bases/b2/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'kb_base_not_found' });
    expect(created).toHaveLength(0);
  });

  it('上传后异步摄取携带管理端切分配置', async () => {
    const spy = vi.spyOn(KbService.prototype, 'ingest').mockResolvedValue(undefined);
    try {
      const form = multipartForm('a.txt', 'hello');
      const res = await app.inject({ method: 'POST', url: '/api/kb/bases/b1/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
      expect(res.statusCode).toBe(202);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toEqual({ chunkSize: 600, chunkOverlap: 100 });
    } finally {
      spy.mockRestore();
    }
  });

  it('配置读取失败时上传仍 202，摄取降级为 undefined 且不标记 failed', async () => {
    kbConfigError = new Error('settings db down');
    const ingestSpy = vi.spyOn(KbService.prototype, 'ingest').mockResolvedValue(undefined);
    const failSpy = vi.spyOn(KbService.prototype, 'markFailed').mockResolvedValue(undefined);
    try {
      const form = multipartForm('a.txt', 'hello');
      const res = await app.inject({ method: 'POST', url: '/api/kb/bases/b1/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ filename: 'a.txt', status: 'pending' });
      // 摄取链在响应后异步执行，等它跑完再断言。
      await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledTimes(1));
      expect(ingestSpy.mock.calls[0][1]).toBeUndefined();
      expect(failSpy).not.toHaveBeenCalled();
    } finally {
      ingestSpy.mockRestore();
      failSpy.mockRestore();
    }
  });

  it('不支持的类型返回 400 unsupported_type', async () => {
    const form = multipartForm('a.exe', 'x', 'application/octet-stream');
    const res = await app.inject({ method: 'POST', url: '/api/kb/bases/b1/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported_type' });
  });

  it('超过 KB_MAX_FILE_BYTES 返回 413', async () => {
    const form = multipartForm('a.txt', 'x'.repeat(5000));
    const res = await app.inject({ method: 'POST', url: '/api/kb/bases/b1/docs', headers: { ...auth(), ...form.headers }, payload: form.body });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file_too_large' });
  });

  it('删除文档返回结果并清理对象', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/bases/b1/docs/d1', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deletedDocs: 1, cleanupFailed: 0 });
    expect(deletedDocs).toEqual(['d1']);
    expect(deletedObjects).toEqual([['kb/t1/u1/b1/x/a.txt']]);
  });

  it('删除非本人文档 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/bases/b1/docs/other', headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'kb_doc_not_found' });
  });

  it('删除知识库：级联删文档、清理助手绑定与对象', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/bases/b1', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deletedDocs: 1, cleanupFailed: 0 });
    expect(deletedBases).toEqual(['b1']);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].sql).toContain('array_remove');
    expect(execCalls[0].values).toContain('b1');
    expect(deletedObjects).toEqual([['kb/t1/u1/b1/x/a.txt']]);
  });

  it('删除他人知识库 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/bases/b2', headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'kb_base_not_found' });
    expect(deletedBases).toHaveLength(0);
  });

  it('归属查询故障时原样抛出（500），不伪装成 404', async () => {
    lookupFail = true;
    const res = await app.inject({ method: 'DELETE', url: '/api/kb/bases/b1/docs/d1', headers: auth() });
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
        payload: { vector: [1, 0, 0], topK: 5, tenantId: 't1', userId: 'u1', kbIds: ['b1'] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      delete process.env.INTERNAL_TOKEN;
    }
  });

  it('旧版 docIds 参数被拒绝（fail closed，避免检索范围放大）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/kb/search',
      payload: { vector: [1], topK: 5, tenantId: 't1', userId: 'u1', docIds: ['d1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
  });

  it('kbIds 形状非法返回 400', async () => {
    for (const kbIds of ['x', ['']]) {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/kb/search',
        payload: { vector: [1], topK: 5, tenantId: 't1', userId: 'u1', kbIds },
      });
      expect(res.statusCode).toBe(400);
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
