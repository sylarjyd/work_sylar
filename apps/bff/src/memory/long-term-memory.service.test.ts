import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../db/prisma.service';
import {
  LongTermMemoryService,
  MEMORY_MAX_PER_USER,
  MEMORY_SCORE_THRESHOLD,
  memoryHash,
  normalizeMemoryContent,
} from './long-term-memory.service';

interface RawCall {
  sql: string;
  values: unknown[];
}

/** 真实 Prisma 会把嵌套片段摊平；测试桩复现同样的 SQL/参数形态。 */
function flattenSql(strings: TemplateStringsArray, values: unknown[]): RawCall {
  let sql = strings[0];
  const flat: unknown[] = [];
  values.forEach((value, i) => {
    sql += '?';
    flat.push(value);
    sql += strings[i + 1];
  });
  return { sql, values: flat };
}

let rawCalls: RawCall[];
let execCalls: RawCall[];
let searchRows: { id: string; content: string; score: unknown }[];
let failDelete: boolean;
let failUpdate: boolean;
let failInsert: boolean;

const fakePrisma = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    rawCalls.push(flattenSql(strings, values));
    return searchRows;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = flattenSql(strings, values);
    execCalls.push(call);
    if (failDelete && call.sql.includes('DELETE FROM "UserMemory"')) {
      throw new Error('delete_boom');
    }
    if (failUpdate && call.sql.includes('lastUsedAt')) {
      throw new Error('update_boom');
    }
    if (failInsert && call.sql.includes('INSERT INTO "UserMemory"')) {
      throw new Error('insert_boom');
    }
    return 1;
  },
} as unknown as PrismaService;

function makeService() {
  return new LongTermMemoryService(fakePrisma);
}

beforeEach(() => {
  rawCalls = [];
  execCalls = [];
  searchRows = [];
  failDelete = false;
  failUpdate = false;
  failInsert = false;
});

describe('记忆归一化', () => {
  it('折叠空白、转小写，同一事实不同排版得到同一 hash', () => {
    expect(normalizeMemoryContent('  用户  偏好 Java  ')).toBe('用户 偏好 java');
    expect(memoryHash('用户  偏好 Java')).toBe(memoryHash(' 用户 偏好 java '));
  });
});

describe('LongTermMemoryService.retrieve', () => {
  it('按 tenant/user/阈值/topK 检索并把距离换算为相似度', async () => {
    searchRows = [{ id: 'm1', content: '偏好简洁', score: '0.87' }];
    const hits = await makeService().retrieve({
      tenantId: 't1',
      userId: 'u1',
      vector: [0.1, 0.2],
      topK: 5,
    });
    expect(hits).toEqual([{ id: 'm1', content: '偏好简洁', score: 0.87 }]);
    expect(rawCalls[0].sql).toContain('FROM "UserMemory"');
    expect(rawCalls[0].sql).toContain('"tenantId" = ?');
    expect(rawCalls[0].sql).toContain('"userId" = ?');
    expect(rawCalls[0].values).toContain('t1');
    expect(rawCalls[0].values).toContain('u1');
    expect(rawCalls[0].values).toContain(MEMORY_SCORE_THRESHOLD);
    expect(rawCalls[0].values).toContain(5);
    // 召回即视为使用：更新 lastUsedAt。
    expect(execCalls[0].sql).toContain('lastUsedAt');
  });

  it('空向量或 topK 为 0 时不查库', async () => {
    const svc = makeService();
    await expect(
      svc.retrieve({ tenantId: 't1', userId: 'u1', vector: [], topK: 5 }),
    ).resolves.toEqual([]);
    await expect(
      svc.retrieve({ tenantId: 't1', userId: 'u1', vector: [1], topK: 0 }),
    ).resolves.toEqual([]);
    expect(rawCalls).toHaveLength(0);
  });

  it('lastUsedAt 更新失败不影响召回', async () => {
    failUpdate = true;
    searchRows = [{ id: 'm1', content: '偏好', score: 0.9 }];
    await expect(
      makeService().retrieve({ tenantId: 't1', userId: 'u1', vector: [1], topK: 5 }),
    ).resolves.toHaveLength(1);
  });
});

describe('LongTermMemoryService.remember', () => {
  it('按 hash 去重写入并修剪到每用户 500 条', async () => {
    await makeService().remember({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      items: [
        { content: '喜欢简洁', vector: [1, 0] },
        { content: ' 喜欢  简洁 ', vector: [1, 0] },
        { content: '在成都工作', vector: [0, 1] },
      ],
    });
    const inserts = execCalls.filter((c) => c.sql.includes('INSERT INTO "UserMemory"'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toContain('ON CONFLICT');
    expect(inserts[0].values).toContain('t1');
    expect(inserts[0].values).toContain('u1');
    expect(inserts[0].values).toContain('s1');
    const prune = execCalls.at(-1)!;
    expect(prune.sql).toContain('DELETE FROM "UserMemory"');
    expect(prune.values).toContain(MEMORY_MAX_PER_USER);
  });

  it('单条写入失败不影响其余写入，且仍执行修剪', async () => {
    failInsert = true;
    await expect(
      makeService().remember({
        tenantId: 't1',
        userId: 'u1',
        sessionId: 's1',
        items: [
          { content: '偏好一', vector: [1] },
          { content: '偏好二', vector: [1] },
        ],
      }),
    ).resolves.toBeUndefined();
    const inserts = execCalls.filter((c) => c.sql.includes('INSERT INTO "UserMemory"'));
    expect(inserts).toHaveLength(2);
    expect(execCalls.at(-1)!.sql).toContain('DELETE FROM "UserMemory"');
  });

  it('修剪失败只记日志，不向调用方抛出', async () => {
    failDelete = true;
    await expect(
      makeService().remember({
        tenantId: 't1',
        userId: 'u1',
        sessionId: 's1',
        items: [{ content: '偏好', vector: [1] }],
      }),
    ).resolves.toBeUndefined();
  });
});
