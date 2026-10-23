import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { KbService } from './kb.service';
import type { PrismaService } from '../db/prisma.service';

interface RawCall {
  sql: string;
  values: unknown[];
}

/** 真实 Prisma 会把嵌套的 Prisma.sql 片段摊平；测试桩要复现同样行为。 */
function flattenSql(strings: TemplateStringsArray, values: unknown[]): RawCall {
  let sql = strings[0];
  const flat: unknown[] = [];
  values.forEach((value, i) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      'sql' in value &&
      'values' in value
    ) {
      const nested = value as { sql: string; values: unknown[] };
      sql += nested.sql;
      flat.push(...nested.values);
    } else {
      sql += '?';
      flat.push(value);
    }
    sql += strings[i + 1];
  });
  return { sql, values: flat };
}

type Row = Record<string, unknown>;

let rawCalls: RawCall[];
let execCalls: RawCall[];
let deleteCalls: { docId: string }[];
let searchRows: unknown[];
let bases: Row[];
let docRows: Row[];
let statRows: Row[];
let docDeleteCalls: string[];
let baseDeleteCalls: string[];
let createConflict: boolean;
let runtimeStatus = 200;
let runtimeBody = JSON.stringify({ ok: true, chunks: [{ seq: 0, text: 't', vector: [1, 0, 0] }] });
let runtimeCalls: Record<string, unknown>[];

const fakePrisma = {
  knowledgeBase: {
    findMany: async () => bases,
    findFirst: async ({ where }: { where: Row }) =>
      bases.find(
        (b) =>
          (where.id === undefined || b.id === where.id) &&
          (where.tenantId === undefined || b.tenantId === where.tenantId) &&
          (where.userId === undefined || b.userId === where.userId),
      ) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (createConflict) throw Object.assign(new Error('unique'), { code: 'P2002' });
      return {
        id: 'b9',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...data,
      };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => ({
      ...(bases.find((b) => b.id === where.id) ?? {}),
      ...data,
    }),
    delete: async ({ where }: { where: Row }) => {
      baseDeleteCalls.push(String(where.id));
      return {};
    },
  },
  kbDoc: {
    groupBy: async () => statRows,
    create: async ({ data }: { data: Row }) => ({
      id: 'd9',
      chunkCount: 0,
      error: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      status: 'pending',
      ...data,
    }),
    findMany: async ({ where }: { where: Row } = { where: {} }) =>
      docRows.filter(
        (r) =>
          (where.knowledgeBaseId === undefined || r.knowledgeBaseId === where.knowledgeBaseId) &&
          (where.tenantId === undefined || r.tenantId === where.tenantId) &&
          (where.userId === undefined || r.userId === where.userId),
      ),
    findFirst: async ({ where }: { where: Row }) =>
      docRows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.knowledgeBaseId === undefined || r.knowledgeBaseId === where.knowledgeBaseId) &&
          (where.tenantId === undefined || r.tenantId === where.tenantId) &&
          (where.userId === undefined || r.userId === where.userId),
      ) ?? null,
    update: async ({ data }: { data: Row }) => ({ ...data }),
    updateMany: async () => ({ count: 0 }),
    delete: async ({ where }: { where: Row }) => {
      docDeleteCalls.push(String(where.id));
      return {};
    },
  },
  kbChunk: {
    deleteMany: async ({ where }: { where: { docId: string } }) => {
      deleteCalls.push(where);
      return { count: 0 };
    },
  },
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakePrisma),
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    rawCalls.push(flattenSql(strings, values));
    return searchRows;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execCalls.push(flattenSql(strings, values));
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

function base(id = 'b1', userId = 'u1'): Row {
  return {
    id,
    tenantId: 't1',
    userId,
    name: `库${id}`,
    description: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

beforeEach(() => {
  rawCalls = [];
  execCalls = [];
  deleteCalls = [];
  docDeleteCalls = [];
  baseDeleteCalls = [];
  searchRows = [];
  bases = [base()];
  docRows = [];
  statRows = [];
  createConflict = false;
  runtimeStatus = 200;
  runtimeCalls = [];
  runtimeBody = JSON.stringify({ ok: true, chunks: [{ seq: 0, text: '切片', vector: [1, 0, 0] }] });
});

describe('KbService.listBases', () => {
  it('按库聚合文档计数、切片数与占用空间', async () => {
    statRows = [
      { knowledgeBaseId: 'b1', status: 'ready', _count: { _all: 2 }, _sum: { chunkCount: 7, size: 100 } },
      { knowledgeBaseId: 'b1', status: 'pending', _count: { _all: 1 }, _sum: { chunkCount: 0, size: 50 } },
      { knowledgeBaseId: null, status: 'ready', _count: { _all: 1 }, _sum: { chunkCount: 1, size: 1 } },
    ];
    const out = await makeService().listBases('t1', 'u1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'b1',
      docCount: 3,
      readyCount: 2,
      pendingCount: 1,
      failedCount: 0,
      chunkCount: 7,
      totalBytes: 150,
    });
  });
});

describe('KbService.createBase', () => {
  it('trim 名称并默认空描述', async () => {
    const dto = await makeService().createBase('t1', 'u1', { name: '  合同库  ' });
    expect(dto).toMatchObject({ name: '合同库', description: '' });
  });

  it('名称为空或超长抛 400', async () => {
    await expect(makeService().createBase('t1', 'u1', { name: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(makeService().createBase('t1', 'u1', { name: 'x'.repeat(61) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('同名冲突映射为 409 kb_base_exists', async () => {
    createConflict = true;
    await expect(makeService().createBase('t1', 'u1', { name: '合同库' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('KbService.updateBase', () => {
  it('空补丁抛 400', async () => {
    await expect(makeService().updateBase('b1', 't1', 'u1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('非本人知识库抛 404', async () => {
    await expect(makeService().updateBase('b1', 't1', 'u2', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('更新描述成功', async () => {
    const dto = await makeService().updateBase('b1', 't1', 'u1', { description: '新描述' });
    expect(dto.description).toBe('新描述');
  });
});

describe('KbService.listDocs', () => {
  it('只返回该知识库下本人文档', async () => {
    docRows = [
      { id: 'd1', knowledgeBaseId: 'b1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', size: 3, status: 'ready', chunkCount: 2, error: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'd2', knowledgeBaseId: 'b2', tenantId: 't1', userId: 'u1', filename: 'b.txt', mime: 'text/plain', size: 3, status: 'ready', chunkCount: 1, error: null, createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const out = await makeService().listDocs('b1', 't1', 'u1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'd1', knowledgeBaseId: 'b1', filename: 'a.txt' });
  });

  it('非本人知识库抛 404', async () => {
    await expect(makeService().listDocs('b1', 't1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KbService.createDoc', () => {
  it('落库到指定知识库，状态 pending', async () => {
    const dto = await makeService().createDoc('b1', {
      tenantId: 't1',
      userId: 'u1',
      filename: 'a.txt',
      mime: 'text/plain',
      size: 3,
      storageKey: 'kb/t1/u1/b1/x/a.txt',
    });
    expect(dto).toMatchObject({ filename: 'a.txt', status: 'pending', knowledgeBaseId: 'b1' });
    expect(typeof dto.createdAt).toBe('string');
  });

  it('知识库不属于该用户时抛 404', async () => {
    await expect(
      makeService().createDoc('b1', {
        tenantId: 't1',
        userId: 'u2',
        filename: 'a.txt',
        mime: 'text/plain',
        size: 3,
        storageKey: 'k',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KbService.removeBase', () => {
  it('返回文档 key、清理助手绑定并删库', async () => {
    docRows = [{ id: 'd1', knowledgeBaseId: 'b1', tenantId: 't1', userId: 'u1', storageKey: 'k1' }];
    const out = await makeService().removeBase('b1', 't1', 'u1');
    expect(out).toEqual({ name: '库b1', deletedDocs: 1, storageKeys: ['k1'] });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].sql).toContain('array_remove');
    expect(execCalls[0].values).toContain('b1');
    expect(baseDeleteCalls).toEqual(['b1']);
  });

  it('非本人知识库抛 NotFound', async () => {
    await expect(makeService().removeBase('b1', 't1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
    expect(baseDeleteCalls).toHaveLength(0);
  });
});

describe('KbService.removeDoc', () => {
  it('按知识库+租户+用户限定删除', async () => {
    docRows = [{ id: 'd1', knowledgeBaseId: 'b1', tenantId: 't1', userId: 'u1', filename: 'a.txt', storageKey: 'k1' }];
    const out = await makeService().removeDoc('b1', 'd1', 't1', 'u1');
    expect(out).toEqual({ filename: 'a.txt', storageKey: 'k1' });
    expect(docDeleteCalls).toEqual(['d1']);
  });

  it('文档不在该知识库/非本人时抛 404', async () => {
    docRows = [{ id: 'd1', knowledgeBaseId: 'b2', tenantId: 't1', userId: 'u1', filename: 'a.txt', storageKey: 'k1' }];
    await expect(makeService().removeDoc('b1', 'd1', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(docDeleteCalls).toHaveLength(0);
  });
});

describe('KbService.search', () => {
  it('按 tenant+user 过滤、限制 topK、相似度 1-距离', async () => {
    searchRows = [{ docName: 'a.docx', seq: 0, dist: 0.2, text: '内容' }];
    const out = await makeService().search('t1', 'u1', [1, 0, 0], 5);
    expect(out).toEqual([{ docName: 'a.docx', seq: 0, score: 0.8, text: '内容' }]);
    const call = rawCalls[0];
    expect(call.sql).toContain('<=>');
    expect(call.sql).toContain('LIMIT');
    expect(call.sql).not.toContain('knowledgeBaseId');
    expect(call.values).toContain('t1');
    expect(call.values).toContain('u1');
    expect(call.values).toContain('[1,0,0]');
    expect(call.values).toContain(5);
  });

  it('传入 kbIds 时按知识库过滤', async () => {
    await makeService().search('t1', 'u1', [1, 0, 0], 5, ['b1', 'b2']);
    const call = rawCalls[0];
    expect(call.sql).toContain('knowledgeBaseId');
    expect(call.values).toContainEqual(['b1', 'b2']);
  });

  it('空 kbIds 数组不过滤（等价于全部）', async () => {
    await makeService().search('t1', 'u1', [1, 0, 0], 5, []);
    expect(rawCalls[0].sql).not.toContain('knowledgeBaseId');
  });
});

describe('KbService.ingest', () => {
  beforeEach(() => {
    // 归属校验要求文档存在且属于该 tenant/user。
    docRows = [{ id: 'd1', tenantId: 't1', userId: 'u1', knowledgeBaseId: 'b1', storageKey: 'k' }];
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

  it('ingest 把请求级 chunk 参数带给 runtime', async () => {
    await makeService().ingest(
      { id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' },
      { chunkSize: 600, chunkOverlap: 100 },
    );
    expect(runtimeCalls[0]).toMatchObject({ chunkSize: 600, chunkOverlap: 100 });
  });

  it('未传 chunk 参数时不下发该字段（runtime 自行回落）', async () => {
    await makeService().ingest({ id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' });
    expect(runtimeCalls[0]).not.toHaveProperty('chunkSize');
    expect(runtimeCalls[0]).not.toHaveProperty('chunkOverlap');
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
