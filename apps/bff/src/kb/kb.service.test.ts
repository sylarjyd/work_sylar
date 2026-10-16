import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { KbService } from './kb.service';
import type { PrismaService } from '../db/prisma.service';

interface RawCall {
  sql: string;
  values: unknown[];
}

let rawCalls: RawCall[];
let execCalls: RawCall[];
let deleteCalls: { docId: string }[];
let searchRows: unknown[];
let docRows: Record<string, unknown>[];
let runtimeStatus = 200;
let runtimeBody = JSON.stringify({ ok: true, chunks: [{ seq: 0, text: 't', vector: [1, 0, 0] }] });

const fakePrisma = {
  kbDoc: {
    create: async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'd1',
      chunkCount: 0,
      error: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      status: 'pending',
      ...data,
    }),
    findMany: async () => docRows,
    findFirst: async ({ where }: { where: { id: string } }) =>
      docRows.find((r) => r.id === where.id) ?? null,
    update: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }),
    updateMany: async () => ({ count: 0 }),
    delete: async () => ({}),
  },
  kbChunk: {
    deleteMany: async ({ where }: { where: { docId: string } }) => {
      deleteCalls.push(where);
      return { count: 0 };
    },
  },
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakePrisma),
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    rawCalls.push({ sql: strings.join('?'), values });
    return searchRows;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execCalls.push({ sql: strings.join('?'), values });
    return 1;
  },
} as unknown as PrismaService;

function makeService() {
  return new KbService(fakePrisma, {
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      runtimeCalls.push(body);
      return new Response(runtimeBody, { status: runtimeStatus, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    runtimeUrl: 'http://runtime',
  });
}

let runtimeCalls: Record<string, unknown>[];

beforeEach(() => {
  rawCalls = [];
  execCalls = [];
  deleteCalls = [];
  searchRows = [];
  docRows = [];
  runtimeStatus = 200;
  runtimeCalls = [];
  runtimeBody = JSON.stringify({ ok: true, chunks: [{ seq: 0, text: '切片', vector: [1, 0, 0] }] });
});

describe('KbService.search', () => {
  it('按 tenant+user 过滤、限制 topK、相似度 1-距离', async () => {
    searchRows = [{ docName: 'a.docx', seq: 0, dist: 0.2, text: '内容' }];
    const out = await makeService().search('t1', 'u1', [1, 0, 0], 5);
    expect(out).toEqual([{ docName: 'a.docx', seq: 0, score: 0.8, text: '内容' }]);
    const call = rawCalls[0];
    expect(call.sql).toContain('<=>');
    expect(call.sql).toContain('LIMIT');
    expect(call.values).toContain('t1');
    expect(call.values).toContain('u1');
    expect(call.values).toContain('[1,0,0]');
    expect(call.values).toContain(5);
  });
});

describe('KbService.create', () => {
  it('落库返回 DTO，状态 pending', async () => {
    const dto = await makeService().create({
      tenantId: 't1',
      userId: 'u1',
      filename: 'a.txt',
      mime: 'text/plain',
      size: 3,
      storageKey: 'kb/t1/u1/x/a.txt',
    });
    expect(dto).toMatchObject({ filename: 'a.txt', status: 'pending', chunkCount: 0, error: null });
    expect(typeof dto.createdAt).toBe('string');
  });
});

describe('KbService.list', () => {
  it('只返回本人文档（透传 where 过滤）', async () => {
    docRows = [
      { id: 'd1', filename: 'a.txt', mime: 'text/plain', size: 3, status: 'ready', chunkCount: 2, error: null, createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const out = await makeService().list('t1', 'u1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filename: 'a.txt', status: 'ready', chunkCount: 2 });
  });
});

describe('KbService.remove', () => {
  it('非本人文档抛 NotFound', async () => {
    docRows = [];
    await expect(makeService().remove('d1', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('本人文档：级联删除后删 doc', async () => {
    docRows = [{ id: 'd1' }];
    await expect(makeService().remove('d1', 't1', 'u1')).resolves.toBeUndefined();
  });
});

describe('KbService.ingest', () => {
  beforeEach(() => {
    // 归属校验要求文档存在且属于该 tenant/user。
    docRows = [{ id: 'd1', tenantId: 't1', userId: 'u1' }];
  });

  it('归属校验：非本人/不存在文档抛 NotFound，不调 runtime、不写切片', async () => {
    docRows = [];
    await expect(
      makeService().ingest({ id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(runtimeCalls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });

  it('摄取成功：写入切片（向量字面量）并置 ready', async () => {
    runtimeBody = JSON.stringify({
      ok: true,
      chunks: [
        { seq: 0, text: '甲', vector: [1, 0, 0] },
        { seq: 1, text: '乙', vector: [0, 1, 0] },
      ],
    });
    await makeService().ingest({ id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' });
    expect(runtimeCalls[0]).toMatchObject({ storageKey: 'k', filename: 'a.txt', mime: 'text/plain' });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0].values).toContain('[1,0,0]');
    expect(execCalls[1].values).toContain('[0,1,0]');
  });

  it('摄取前先按 docId 清掉旧切片（幂等）', async () => {
    await makeService().ingest({ id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' });
    expect(deleteCalls).toEqual([{ docId: 'd1' }]);
  });

  it('runtime 回 ok:false 时抛错（由调用方置 failed）', async () => {
    runtimeBody = JSON.stringify({ ok: false, error: 'empty_document' });
    await expect(
      makeService().ingest({ id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' }),
    ).rejects.toThrow('empty_document');
  });

  it('runtime 不可达时抛错', async () => {
    const svc = new KbService(fakePrisma, {
      runtimeUrl: 'http://runtime',
      fetchImpl: (async () => {
        throw new Error('econnrefused');
      }) as unknown as typeof fetch,
    });
    await expect(
      svc.ingest({ id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' }),
    ).rejects.toThrow('runtime_unreachable');
  });
});
