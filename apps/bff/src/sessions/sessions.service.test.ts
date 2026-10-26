import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { ModelUnavailableError } from '../models/model.errors';
import type { ModelCatalogService } from '../models/model-catalog.service';
import type { PrismaService } from '../db/prisma.service';

interface AssistantFixture {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  systemPrompt: string;
  permissionMode: string;
  model: string | null;
  skills: string[];
  kbIds: string[];
}

const ASSISTANT: AssistantFixture = {
  id: 'a1',
  tenantId: 't1',
  userId: 'u1',
  name: '合同助手',
  systemPrompt: '你是合同审阅助手',
  permissionMode: 'readonly',
  model: 'm2',
  skills: ['kb', 'web'],
  kbIds: ['b1'],
};

const all = [
  {
    id: 's1',
    tenantId: 't1',
    userId: 'u1',
    title: 'active',
    titleSource: 'auto',
    status: 'active',
    pinned: false,
    model: 'm1',
    assistantId: 'a1',
    mode: 'task',
    // 显式拉开创建时间，列表按 createdAt 降序断言才不会受同毫秒影响。
    createdAt: new Date('2026-01-03T00:00:00Z'),
  },
  {
    id: 's2',
    tenantId: 't1',
    userId: 'u1',
    title: 'archived',
    titleSource: 'auto',
    status: 'archived',
    pinned: false,
    model: null,
    assistantId: null,
    mode: 'chat',
    createdAt: new Date('2026-01-02T00:00:00Z'),
  },
  {
    id: 's3',
    tenantId: 't1',
    userId: 'u1',
    title: 'default',
    titleSource: 'auto',
    status: 'active',
    pinned: false,
    model: 'm1',
    assistantId: null,
    mode: 'chat',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
];

/** 模拟 where.status：字符串等值或 { not } 排除。 */
function matchesStatus(row: { status: string }, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (typeof cond === 'string') return row.status === cond;
  const not = (cond as { not?: string }).not;
  return not === undefined || row.status !== not;
}

function withAssistant<T extends { assistantId: string | null }>(s: T) {
  return {
    ...s,
    assistant: s.assistantId === ASSISTANT.id ? { name: ASSISTANT.name } : null,
  };
}

function makeService(
  models = ['m1', 'm2'],
  defaultModel: string | null = 'm1',
  assistants: AssistantFixture[] = [ASSISTANT],
  rows = all,
  busyTasks: { sessionId: string; status: string }[] = [],
) {
  // 每份用例独立可变数据：改名/置顶/删除会写回，不能污染共享的 all。
  const data = rows.map((s) => ({ ...s }));
  const created: { model?: string; assistantId?: string | null; mode?: string }[] = [];
  const prisma = {
    session: {
      findMany: async ({
        where,
        take,
        cursor,
        skip,
      }: {
        where: { tenantId: string; userId: string; status?: unknown };
        take?: number;
        cursor?: { id: string };
        skip?: number;
      }) => {
        let list = data
          .filter(
            (s) =>
              s.tenantId === where.tenantId &&
              s.userId === where.userId &&
              matchesStatus(s, where.status),
          )
          // 与真实查询同序：置顶优先，createdAt 降序，id 兜底，游标翻页依赖这个顺序。
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              b.createdAt.getTime() - a.createdAt.getTime() ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          );
        if (cursor) {
          const at = list.findIndex((s) => s.id === cursor.id);
          if (at >= 0) list = list.slice(at + (skip ?? 0));
        }
        if (take !== undefined) list = list.slice(0, take);
        return list.map(withAssistant);
      },
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string; userId: string; status?: unknown };
      }) => {
        const row =
          data.find(
            (s) =>
              s.id === where.id &&
              s.tenantId === where.tenantId &&
              s.userId === where.userId &&
              matchesStatus(s, where.status),
          ) ?? null;
        if (!row) return null;
        return {
          ...row,
          assistant:
            row.assistantId === ASSISTANT.id
              ? assistants.find((a) => a.id === ASSISTANT.id) ?? null
              : null,
        };
      },
      updateMany: async ({
        where,
        data: patch,
      }: {
        where: { id: string; tenantId: string; userId: string; status?: unknown };
        data: Record<string, unknown>;
      }) => {
        const row = data.find(
          (s) =>
            s.id === where.id &&
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            matchesStatus(s, where.status),
        );
        if (!row) return { count: 0 };
        Object.assign(row, patch);
        return { count: 1 };
      },
      create: async ({
        data,
      }: {
        data: {
          tenantId: string;
          userId: string;
          title: string;
          model?: string;
          assistantId?: string | null;
          mode?: string;
        };
      }) => {
        created.push({ model: data.model, assistantId: data.assistantId, mode: data.mode });
        return {
          id: 's4',
          createdAt: new Date(),
          ...data,
          assistant:
            data.assistantId === ASSISTANT.id ? { name: ASSISTANT.name } : null,
        };
      },
    },
    assistant: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string; userId: string };
      }) =>
        assistants.find(
          (a) =>
            a.id === where.id && a.tenantId === where.tenantId && a.userId === where.userId,
        ) ?? null,
    },
    task: {
      findFirst: async ({
        where,
      }: {
        where: { sessionId: string; status: { in: string[] } };
      }) =>
        busyTasks.find(
          (t) => t.sessionId === where.sessionId && where.status.in.includes(t.status),
        ) ?? null,
    },
  } as unknown as PrismaService;
  const catalog = {
    available: async () => ({
      models: models.map((model) => ({
        model,
        displayName: model,
        providerName: 'p',
        sortOrder: 0,
        source: { kind: 'mock' as const },
      })),
      defaultModel,
    }),
  } as unknown as ModelCatalogService;
  return { svc: new SessionsService(prisma, catalog), created, rows: data };
}

describe('SessionsService 归档语义', () => {
  it('list 不返回归档会话，并带出会话模型与助手名', async () => {
    const page = await makeService().svc.list('t1', 'u1');
    const list = page.items;
    expect(page.nextCursor).toBeNull();
    expect(list.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(list[0].model).toBe('m1');
    expect(list[0].assistantId).toBe('a1');
    expect(list[0].assistantName).toBe('合同助手');
    expect(list[0].mode).toBe('task');
    expect(list[1].mode).toBe('chat');
    expect(list[1].assistantName).toBeNull();
  });

  it('归档会话对普通用户视为不存在', async () => {
    await expect(makeService().svc.assertOwned('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/** 生成按 createdAt 降序排列的会话，用于翻页边界断言。 */
function makeSessions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${String(i).padStart(2, '0')}`,
    tenantId: 't1',
    userId: 'u1',
    title: `会话 ${i}`,
    titleSource: 'auto',
    status: 'active',
    pinned: false,
    model: 'm1',
    assistantId: null as string | null,
    mode: 'chat',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)),
  }));
}

describe('SessionsService 历史会话分页', () => {
  it('默认返回最近 20 条，并用游标续拉剩余会话', async () => {
    const { svc } = makeService(['m1'], 'm1', [ASSISTANT], makeSessions(25));
    const page = await svc.list('t1', 'u1');
    expect(page.items).toHaveLength(20);
    expect(page.items[0].id).toBe('s00');
    expect(page.items[19].id).toBe('s19');
    expect(page.nextCursor).toBe('s19');

    const next = await svc.list('t1', 'u1', { cursor: page.nextCursor ?? undefined });
    expect(next.items.map((s) => s.id)).toEqual(['s20', 's21', 's22', 's23', 's24']);
    expect(next.nextCursor).toBeNull();
  });

  it('limit 非法时回落到默认值，超过上限时截断', async () => {
    const { svc } = makeService(['m1'], 'm1', [ASSISTANT], makeSessions(25));
    expect((await svc.list('t1', 'u1', { limit: 0 })).items).toHaveLength(20);
    expect((await svc.list('t1', 'u1', { limit: Number.NaN })).items).toHaveLength(20);
    const capped = await svc.list('t1', 'u1', { limit: 1000 });
    expect(capped.items).toHaveLength(25);
    expect(capped.nextCursor).toBeNull();
  });

  it('不足一页时不返回游标', async () => {
    const { svc } = makeService(['m1'], 'm1', [ASSISTANT], makeSessions(3));
    const page = await svc.list('t1', 'u1', { limit: 20 });
    expect(page.items.map((s) => s.id)).toEqual(['s00', 's01', 's02']);
    expect(page.nextCursor).toBeNull();
  });
});

describe('SessionsService 单个会话摘要', () => {
  it('返回指定会话的摘要', async () => {
    const s = await makeService().svc.detail('s1', 't1', 'u1');
    expect(s).toMatchObject({
      id: 's1',
      title: 'active',
      model: 'm1',
      assistantId: 'a1',
      assistantName: '合同助手',
      mode: 'task',
    });
  });

  it('归档或他人会话一律 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.detail('s1', 't2', 'u2')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SessionsService 选模', () => {
  it('未指定模型时使用默认模型并落库', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', {});
    expect(s.model).toBe('m1');
    expect(created).toEqual([{ model: 'm1', assistantId: null, mode: 'chat' }]);
  });

  it('指定模型必须在可用列表内', async () => {
    const { svc, created } = makeService();
    await expect(svc.create('t1', 'u1', { model: 'gone' })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(created).toEqual([]);
  });

  it('指定可用模型时原样落库', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { model: 'm2' });
    expect(s.model).toBe('m2');
    expect(created).toEqual([{ model: 'm2', assistantId: null, mode: 'chat' }]);
  });

  it('未显式选模时使用助手默认模型，并绑定助手', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { assistantId: 'a1' });
    expect(s.model).toBe('m2');
    expect(s.assistantName).toBe('合同助手');
    expect(created).toEqual([{ model: 'm2', assistantId: 'a1', mode: 'chat' }]);
  });

  it('显式模型优先于助手默认模型', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { assistantId: 'a1', model: 'm1' });
    expect(s.model).toBe('m1');
    expect(created).toEqual([{ model: 'm1', assistantId: 'a1', mode: 'chat' }]);
  });

  it('任务分类随会话落库并回显', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { mode: 'code' });
    expect(s.mode).toBe('code');
    expect(created).toEqual([{ model: 'm1', assistantId: null, mode: 'code' }]);
  });

  it('非法分类退回对话，不让建会话失败', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { mode: 'bogus' as never });
    expect(s.mode).toBe('chat');
    expect(created).toEqual([{ model: 'm1', assistantId: null, mode: 'chat' }]);
  });

  it('绑定他人/不存在的助手一律 404', async () => {
    const { svc, created } = makeService();
    await expect(svc.create('t2', 'u2', { assistantId: 'a1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(created).toEqual([]);
  });

  it('assertOwned 返回会话模型与助手配置供运行时解析', async () => {
    const ref = await makeService().svc.assertOwned('s1', 't1', 'u1');
    expect(ref).toEqual({
      id: 's1',
      model: 'm1',
      assistantId: 'a1',
      assistantName: '合同助手',
      mode: 'task',
      assistant: {
        id: 'a1',
        name: '合同助手',
        systemPrompt: '你是合同审阅助手',
        permissionMode: 'readonly',
        skills: ['web', 'kb'],
        kbIds: ['b1'],
      },
    });
  });
});

describe('SessionsService 改名与置顶', () => {
  it('改名去除首尾空格，并把标题来源标记为 manual', async () => {
    const { svc, rows } = makeService();
    const s = await svc.update('s1', 't1', 'u1', { title: '  周报草稿  ' });
    expect(s.title).toBe('周报草稿');
    expect(rows.find((r) => r.id === 's1')).toMatchObject({
      title: '周报草稿',
      titleSource: 'manual',
    });
  });

  it('标题为空或超过 40 字时拒绝，且不落库', async () => {
    const { svc, rows } = makeService();
    await expect(svc.update('s1', 't1', 'u1', { title: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.update('s1', 't1', 'u1', { title: '字'.repeat(41) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.find((r) => r.id === 's1')?.title).toBe('active');
  });

  it('置顶后列表排到最前，取消置顶恢复原序', async () => {
    const { svc } = makeService();
    await svc.update('s3', 't1', 'u1', { pinned: true });
    expect((await svc.list('t1', 'u1')).items.map((s) => s.id)).toEqual(['s3', 's1']);
    await svc.update('s3', 't1', 'u1', { pinned: false });
    expect((await svc.list('t1', 'u1')).items.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('pinned 非布尔或没有任何字段时拒绝', async () => {
    const { svc } = makeService();
    await expect(
      svc.update('s1', 't1', 'u1', { pinned: 'yes' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('s1', 't1', 'u1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('他人或已归档会话一律 404', async () => {
    const { svc } = makeService();
    await expect(svc.update('s1', 't2', 'u2', { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.update('s2', 't1', 'u1', { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SessionsService 软删除', () => {
  it('删除后状态变为 deleted，列表与详情都不再可见', async () => {
    const { svc, rows } = makeService();
    await svc.remove('s1', 't1', 'u1');
    expect(rows.find((r) => r.id === 's1')?.status).toBe('deleted');
    expect((await svc.list('t1', 'u1')).items.map((s) => s.id)).toEqual(['s3']);
    await expect(svc.detail('s1', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('有排队/运行中任务时返回 409，会话保持可用', async () => {
    const { svc, rows } = makeService(['m1'], 'm1', [ASSISTANT], all, [
      { sessionId: 's1', status: 'running' },
    ]);
    await expect(svc.remove('s1', 't1', 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(rows.find((r) => r.id === 's1')?.status).toBe('active');
  });

  it('他人、已归档或已删除会话一律 404', async () => {
    const { svc } = makeService();
    await expect(svc.remove('s1', 't2', 'u2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
