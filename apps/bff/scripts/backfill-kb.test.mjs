import { describe, it, expect } from 'vitest';
import { backfillKb, verifyKbBackfill, DEFAULT_KB_NAME } from './backfill-kb.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * 最小内存版 Prisma 桩：只实现回填用到的查询/写入，便于离线验证幂等与兜底。
 * state = { docs: [...], bases: [...], assistants: [...] }
 */
function fakePrisma(state, overrides = {}) {
  const baseKey = (tenantId, userId, name) =>
    state.bases.find((b) => b.tenantId === tenantId && b.userId === userId && b.name === name);

  return {
    kbDoc: {
      groupBy: async ({ where }) => {
        const seen = new Map();
        for (const d of state.docs) {
          if (where.knowledgeBaseId === null && d.knowledgeBaseId !== null) continue;
          seen.set(`${d.tenantId}/${d.userId}`, { tenantId: d.tenantId, userId: d.userId });
        }
        return [...seen.values()];
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const d of state.docs) {
          if (where.knowledgeBaseId === null && d.knowledgeBaseId !== null) continue;
          if (d.tenantId !== where.tenantId || d.userId !== where.userId) continue;
          d.knowledgeBaseId = data.knowledgeBaseId;
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }) => {
        const ids = where.id.in;
        return state.docs
          .filter(
            (d) =>
              ids.includes(d.id) &&
              d.tenantId === where.tenantId &&
              d.userId === where.userId,
          )
          .map((d) => ({ knowledgeBaseId: d.knowledgeBaseId }));
      },
      count: async ({ where }) =>
        state.docs.filter((d) =>
          where.knowledgeBaseId === null ? d.knowledgeBaseId === null : true,
        ).length,
    },
    knowledgeBase: {
      findUnique: async ({ where }) => {
        const b = baseKey(
          where.tenantId_userId_name.tenantId,
          where.tenantId_userId_name.userId,
          where.tenantId_userId_name.name,
        );
        return b ? { id: b.id } : null;
      },
      create: async ({ data }) => {
        const row = { id: `base-${state.bases.length + 1}`, ...data };
        state.bases.push(row);
        return { id: row.id };
      },
    },
    assistant: {
      findMany: async ({ where }) =>
        state.assistants
          .filter((a) => (where.kbDocIds?.isEmpty === false ? a.kbDocIds.length > 0 : true))
          .map((a) => ({ ...a })),
      update: async ({ where, data }) => {
        const a = state.assistants.find((x) => x.id === where.id);
        Object.assign(a, data);
        return a;
      },
      count: async ({ where }) =>
        state.assistants.filter((a) =>
          where.kbDocIds?.isEmpty === false ? a.kbDocIds.length > 0 : true,
        ).length,
    },
    // 回填校验里的跨归属检查；默认无异常。
    $queryRaw: async () => [{ count: 0 }],
    ...overrides,
  };
}

function stateWith(fixture) {
  return {
    bases: [],
    docs: [],
    assistants: [],
    ...fixture,
  };
}

describe('backfillKb', () => {
  it('把存量文档归入默认库，并把助手文档绑定转成知识库绑定', async () => {
    const state = stateWith({
      docs: [
        { id: 'd1', tenantId: 't1', userId: 'u1', knowledgeBaseId: null },
        { id: 'd2', tenantId: 't1', userId: 'u1', knowledgeBaseId: null },
        { id: 'd3', tenantId: 't2', userId: 'u2', knowledgeBaseId: null },
      ],
      assistants: [
        { id: 'a1', tenantId: 't1', userId: 'u1', kbDocIds: ['d1', 'd2'], kbIds: [] },
      ],
    });

    const summary = await backfillKb(fakePrisma(state), { logger: silentLogger });

    expect(state.bases).toHaveLength(2);
    expect(state.bases.every((b) => b.name === DEFAULT_KB_NAME)).toBe(true);
    expect(state.docs.every((d) => d.knowledgeBaseId !== null)).toBe(true);
    expect(state.assistants[0].kbIds).toEqual(['base-1']);
    expect(state.assistants[0].kbDocIds).toEqual([]);
    expect(summary).toMatchObject({
      remainingDocs: 0,
      remainingAssistants: 0,
      assistantsConverted: 1,
    });
  });

  it('第二次运行不再写入（幂等）', async () => {
    const state = stateWith({
      docs: [{ id: 'd1', tenantId: 't1', userId: 'u1', knowledgeBaseId: null }],
      assistants: [{ id: 'a1', tenantId: 't1', userId: 'u1', kbDocIds: ['d1'], kbIds: [] }],
    });
    const prisma = fakePrisma(state);
    await backfillKb(prisma, { logger: silentLogger });

    const basesAfterFirst = state.bases.length;
    const summary = await backfillKb(prisma, { logger: silentLogger });

    expect(summary.basesCreated).toBe(0);
    expect(summary.assistantsConverted).toBe(0);
    expect(state.bases).toHaveLength(basesAfterFirst);
  });

  it('多个旧文档映射到同一知识库时去重', async () => {
    const state = stateWith({
      bases: [{ id: 'existing', tenantId: 't1', userId: 'u1', name: DEFAULT_KB_NAME }],
      docs: [
        { id: 'd1', tenantId: 't1', userId: 'u1', knowledgeBaseId: 'kb1' },
        { id: 'd2', tenantId: 't1', userId: 'u1', knowledgeBaseId: 'kb1' },
        { id: 'd3', tenantId: 't1', userId: 'u1', knowledgeBaseId: 'kb2' },
      ],
      assistants: [
        { id: 'a1', tenantId: 't1', userId: 'u1', kbDocIds: ['d1', 'd2', 'd3'], kbIds: [] },
      ],
    });

    await backfillKb(fakePrisma(state), { logger: silentLogger });

    expect(state.assistants[0].kbIds.sort()).toEqual(['kb1', 'kb2']);
  });

  it('旧文档全部丢失时兜底绑定默认知识库，避免范围被放大', async () => {
    const state = stateWith({
      bases: [{ id: 'base-existing', tenantId: 't1', userId: 'u1', name: DEFAULT_KB_NAME }],
      docs: [],
      assistants: [
        { id: 'a1', tenantId: 't1', userId: 'u1', kbDocIds: ['gone'], kbIds: [] },
      ],
    });

    const summary = await backfillKb(fakePrisma(state), { logger: silentLogger });

    expect(state.assistants[0].kbIds).toEqual(['base-existing']);
    expect(state.assistants[0].kbDocIds).toEqual([]);
    expect(summary.assistantsFallback).toBe(1);
  });

  it('没有任何可绑定知识库时保留空数组并告警', async () => {
    const state = stateWith({
      docs: [],
      assistants: [{ id: 'a1', tenantId: 't1', userId: 'u1', kbDocIds: ['gone'], kbIds: [] }],
    });
    const warnings = [];
    const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };

    await backfillKb(fakePrisma(state), { logger });

    expect(state.assistants[0].kbIds).toEqual([]);
    expect(warnings.join(' ')).toContain('assistant_legacy_binding_lost');
  });

  it('校验发现归属不一致时抛错', async () => {
    const state = stateWith({ docs: [], assistants: [] });
    const prisma = fakePrisma(state, { $queryRaw: async () => [{ count: 1 }] });

    await expect(backfillKb(prisma, { logger: silentLogger })).rejects.toThrow('归属不一致');
  });
});

describe('verifyKbBackfill', () => {
  it('返回剩余未归类文档与旧绑定助手数量', async () => {
    const state = stateWith({
      docs: [{ id: 'd1', tenantId: 't1', userId: 'u1', knowledgeBaseId: null }],
      assistants: [{ id: 'a1', tenantId: 't1', userId: 'u1', kbDocIds: ['d1'], kbIds: [] }],
    });
    const result = await verifyKbBackfill(fakePrisma(state));
    expect(result).toEqual({ remainingDocs: 1, remainingAssistants: 1, mismatchedDocs: 0 });
  });
});
