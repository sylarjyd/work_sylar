import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import type { PrismaService } from '../db/prisma.service';
import type { RunSnapshot } from '../queue/run-job';

type Row = Record<string, any>;

/** 构造一个最小的内存版 Prisma：只实现任务服务用到的方法。 */
function makeDb() {
  const db = {
    messages: [] as Row[],
    tasks: [] as Row[],
    runs: [] as Row[],
    attachments: [] as Row[],
    // 预先排队的 message.create 异常，用来模拟并发唯一键冲突等故障。
    messageCreateErrors: [] as unknown[],
    messageCreateCalls: 0,
    runUpdates: [] as Row[],
    taskUpdates: [] as Row[],
  };

  const sessionMessages = (sessionId: string) => db.messages.filter((m) => m.sessionId === sessionId);

  const client: any = {
    message: {
      // Prisma 的 include/select 总会返回数组；内存版补齐默认值，避免历史夹具漏写 attachments。
      findMany: async ({ where }: any) =>
        [...sessionMessages(where.sessionId)]
          .sort((a, b) => a.seq - b.seq)
          .map((m) => ({ attachments: [], ...m })),
      findFirst: async ({ where }: any) => {
        const rows = [...sessionMessages(where.sessionId)].sort((a, b) => b.seq - a.seq);
        return rows[0] ?? null;
      },
      create: async ({ data }: any) => {
        db.messageCreateCalls += 1;
        const injected = db.messageCreateErrors.shift();
        if (injected) throw injected;
        if (db.messages.some((m) => m.sessionId === data.sessionId && m.seq === data.seq)) {
          throw p2002();
        }
        const row = { id: `m${db.messages.length + 1}`, ...data };
        db.messages.push(row);
        return row;
      },
    },
    task: {
      findUnique: async ({ where }: any) => db.tasks.find((t) => t.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `task${db.tasks.length + 1}`, ...data };
        db.tasks.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        db.taskUpdates.push({ where, data });
        const row = db.tasks.find((t) => t.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? { id: where.id, ...data };
      },
    },
    run: {
      create: async ({ data }: any) => {
        const row = { id: `run${db.runs.length + 1}`, ...data };
        db.runs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        db.runUpdates.push({ where, data });
        const row = db.runs.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? { id: where.id, ...data };
      },
    },
    attachment: {
      // 对齐 Prisma updateMany 语义：仅匹配「归属一致且尚未绑定」的行。
      updateMany: async ({ where, data }: any) => {
        const ids: string[] = where.id.in;
        const rows = db.attachments.filter(
          (a) =>
            ids.includes(a.id) &&
            a.tenantId === where.tenantId &&
            a.userId === where.userId &&
            a.sessionId === where.sessionId &&
            a.messageId === where.messageId,
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      findMany: async ({ where }: any) => db.attachments.filter((a) => a.messageId === where.messageId),
    },
    // 模拟事务回滚：回调抛错时恢复进入事务前的数据快照。
    $transaction: async (fn: any) => {
      const snapshot = {
        messages: [...db.messages],
        tasks: [...db.tasks],
        runs: [...db.runs],
        attachments: db.attachments.map((a) => ({ ...a })),
      };
      try {
        return await fn(client);
      } catch (err) {
        db.messages = snapshot.messages;
        db.tasks = snapshot.tasks;
        db.runs = snapshot.runs;
        db.attachments = snapshot.attachments;
        throw err;
      }
    },
  };

  return { db, prisma: client as unknown as PrismaService };
}

let ctx: ReturnType<typeof makeDb>;
let sessions: { assertOwned: ReturnType<typeof vi.fn> };
let svc: TasksService;

beforeEach(() => {
  ctx = makeDb();
  sessions = { assertOwned: vi.fn().mockResolvedValue(undefined) };
  svc = new TasksService(ctx.prisma, sessions as any);
});

function p2002(target: string[] = ['sessionId', 'seq']): Error {
  const err: any = new Error('unique');
  err.code = 'P2002';
  err.meta = { target };
  return err;
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    goal: '目标',
    messages: [],
    model: 'm1',
    resolution: { selectedModel: 'm1', modelRoutes: [] },
    config: { maxRounds: 3, confirmTimeoutMs: 1000, codeExecTimeoutMs: 5000 },
    traceId: null,
    assistant: null,
    ...overrides,
  };
}

describe('TasksService', () => {
  it('prepare 落 queued 状态并保存快照', async () => {
    ctx.db.messages.push({ id: 'm0', sessionId: 's1', role: 'user', content: '旧消息', seq: 0 });

    const result = await svc.prepare(
      's1',
      't1',
      'u1',
      '写周报',
      'r1',
      'trace',
      [],
      snapshot({ goal: '写周报', traceId: 'trace' }),
    );

    expect(ctx.db.tasks[0]).toMatchObject({ sessionId: 's1', goal: '写周报', status: 'queued' });
    // 入队快照被补全为「历史 + 本次用户消息」，执行器无需再查历史。
    expect(ctx.db.tasks[0].input).toMatchObject({
      goal: '写周报',
      traceId: 'trace',
      messages: [
        { role: 'user', content: '旧消息', attachments: [] },
        { role: 'user', content: '写周报', attachments: [] },
      ],
    });
    expect(ctx.db.runs[0]).toMatchObject({
      id: 'r1',
      taskId: ctx.db.tasks[0].id,
      status: 'queued',
      traceId: 'trace',
    });
    // startedAt 由执行器在真正开始执行时写入，创建路径不能提前写。
    expect(ctx.db.runs[0].startedAt).toBeUndefined();
    // 返回值只带标识，消息历史已经随快照落库。
    expect(result).toEqual({
      taskId: ctx.db.tasks[0].id,
      runId: 'r1',
      tenantId: 't1',
      userId: 'u1',
    });
  });

  it('prepare 遇到 P2002 后重试，消息序号取当前最大值 +1', async () => {
    ctx.db.messages.push({ id: 'm0', sessionId: 's1', role: 'user', content: '旧消息', seq: 0 });
    ctx.db.messageCreateErrors.push(p2002());

    const result = await svc.prepare(
      's1',
      't1',
      'u1',
      '新目标',
      'run1',
      null,
      [],
      snapshot({ goal: '新目标' }),
    );

    // 首次 create 被注入 P2002 异常后重试成功，仍写 seq 1，不出现空洞或重复。
    expect(result.taskId).toBeTruthy();
    expect(result.runId).toBe('run1');
    expect(ctx.db.messageCreateCalls).toBe(2);
    expect(ctx.db.messages.filter((m) => m.role === 'user').map((m) => m.seq)).toEqual([0, 1]);
    expect(ctx.db.messages.find((m) => m.role === 'user' && m.seq === 1)?.content).toBe('新目标');
    expect(ctx.db.tasks[0].input.messages.at(-1)).toEqual({
      role: 'user',
      content: '新目标',
      attachments: [],
    });
    // 首次事务已回滚：重试成功后不应残留第一次创建的 task/run 孤儿。
    expect(ctx.db.tasks).toHaveLength(1);
    expect(ctx.db.runs).toHaveLength(1);
    expect(ctx.db.runs[0].id).toBe('run1');
  });

  it('prepare 只重试 P2002，其他错误立即抛出', async () => {
    const err: any = new Error('fk');
    err.code = 'P2003';
    ctx.db.messageCreateErrors.push(err);

    await expect(
      svc.prepare('s1', 't1', 'u1', '目标', 'run1', null, [], snapshot()),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(ctx.db.messageCreateCalls).toBe(1);
  });

  it('prepare 重试耗尽后抛出，且所有事务均已回滚', async () => {
    for (let i = 0; i < 5; i++) ctx.db.messageCreateErrors.push(p2002());

    await expect(
      svc.prepare('s1', 't1', 'u1', '目标', 'run1', null, [], snapshot()),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(ctx.db.messageCreateCalls).toBe(5);
    expect(ctx.db.tasks).toHaveLength(0);
    expect(ctx.db.runs).toHaveLength(0);
  });

  it('prepare 对 runId 等非 seq 的 P2002 不重试，直接抛出', async () => {
    ctx.db.messageCreateErrors.push(p2002(['id']));

    await expect(
      svc.prepare('s1', 't1', 'u1', '目标', 'run1', null, [], snapshot()),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(ctx.db.messageCreateCalls).toBe(1);
    expect(ctx.db.tasks).toHaveLength(0);
    expect(ctx.db.runs).toHaveLength(0);
  });

  it('finish 的 assistant 消息冲突后重试，seq 取现有最大值 +1', async () => {
    ctx.db.messages.push(
      { id: 'm0', sessionId: 's1', role: 'user', content: '问题', seq: 0 },
      { id: 'm1', sessionId: 's1', role: 'assistant', content: '旧回答', seq: 1 },
    );
    ctx.db.messageCreateErrors.push(p2002());

    await svc.finish('run1', 'task1', 'done', '新回答', 's1');

    expect(ctx.db.messageCreateCalls).toBe(2);
    expect(ctx.db.messages.find((m) => m.content === '新回答')).toMatchObject({
      sessionId: 's1',
      role: 'assistant',
      seq: 2,
    });
    // run/task 状态更新保持原样，且已成功就不因消息冲突回退。
    expect(ctx.db.runUpdates).toHaveLength(1);
    expect(ctx.db.runUpdates[0].where).toEqual({ id: 'run1' });
    expect(ctx.db.taskUpdates).toHaveLength(1);
    expect(ctx.db.taskUpdates[0].where).toEqual({ id: 'task1' });
  });

  it('prepare 持久化 traceId，未提供时写 null', async () => {
    await svc.prepare('s1', 't1', 'u1', '目标', 'run1', 'trace-1', [], snapshot({ traceId: 'trace-1' }));
    expect(ctx.db.runs[0]).toMatchObject({ id: 'run1', traceId: 'trace-1' });

    await svc.prepare('s1', 't1', 'u1', '目标', 'run2', null, [], snapshot());
    expect(ctx.db.runs[1].traceId).toBeNull();
  });

  it('prepare 原子认领附件并按入参顺序写入快照，历史附件一并带上', async () => {
    ctx.db.messages.push({
      id: 'm0',
      sessionId: 's1',
      role: 'user',
      content: '旧消息',
      seq: 0,
      attachments: [
        {
          id: 'a-old',
          kind: 'image',
          filename: 'old.png',
          mime: 'image/png',
          size: 10,
          storageKey: 'attachments/t1/u1/x/old.png',
        },
      ],
    });
    ctx.db.attachments.push(
      { id: 'a1', tenantId: 't1', userId: 'u1', sessionId: null, messageId: null, kind: 'text', filename: 'a.txt', mime: 'text/plain', size: 3, storageKey: 'k1' },
      { id: 'a2', tenantId: 't1', userId: 'u1', sessionId: null, messageId: null, kind: 'image', filename: 'b.png', mime: 'image/png', size: 4, storageKey: 'k2' },
    );

    const result = await svc.prepare(
      's1',
      't1',
      'u1',
      '看附件',
      'run1',
      null,
      ['a2', 'a1', 'a2'],
      snapshot({ goal: '看附件' }),
    );

    // 去重后按调用方给的顺序（a2、a1）返回，便于前端/模型看到稳定顺序。
    const messages = ctx.db.tasks[0].input.messages as Row[];
    expect(messages.at(-1)?.attachments.map((a: Row) => a.id)).toEqual(['a2', 'a1']);
    expect(messages[0].attachments.map((a: Row) => a.id)).toEqual(['a-old']);
    expect(ctx.db.attachments).toMatchObject([
      { id: 'a1', sessionId: 's1', messageId: 'm2' },
      { id: 'a2', sessionId: 's1', messageId: 'm2' },
    ]);
    expect(result).not.toHaveProperty('messages');
  });

  it('prepare 认领数量不符时整体回滚，不留下消息/任务/绑定', async () => {
    ctx.db.attachments.push(
      { id: 'a1', tenantId: 't1', userId: 'u2', sessionId: null, messageId: null, kind: 'text', filename: 'a.txt', mime: 'text/plain', size: 3, storageKey: 'k1' },
    );

    await expect(
      svc.prepare('s1', 't1', 'u1', '看附件', 'run1', null, ['a1'], snapshot({ goal: '看附件' })),
    ).rejects.toThrow('attachment_not_found');

    expect(ctx.db.messages).toHaveLength(0);
    expect(ctx.db.tasks).toHaveLength(0);
    expect(ctx.db.runs).toHaveLength(0);
    expect(ctx.db.attachments[0]).toMatchObject({ sessionId: null, messageId: null });
  });

  it('countRunning 可排除自身任务，崩溃重投时不会自锁', async () => {
    const count = vi.fn().mockResolvedValue(1);
    const counting = new TasksService({ task: { count } } as any, sessions as any);

    await expect(counting.countRunning('t1', 'task-self')).resolves.toBe(1);
    expect(count).toHaveBeenLastCalledWith({
      where: { status: 'running', session: { tenantId: 't1' }, id: { not: 'task-self' } },
    });

    // 不传排除项时保持原有语义。
    await counting.countRunning('t1');
    expect(count).toHaveBeenLastCalledWith({
      where: { status: 'running', session: { tenantId: 't1' } },
    });
  });

  it('countQueued 可排除新任务自身，避免入队时把自己算进上限', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const counting = new TasksService({ task: { count } } as any, sessions as any);

    await expect(counting.countQueued('t1', 'task-self')).resolves.toBe(0);
    expect(count).toHaveBeenLastCalledWith({
      where: { status: 'queued', session: { tenantId: 't1' }, id: { not: 'task-self' } },
    });

    // 不传排除项时保持原有语义。
    await counting.countQueued('t1');
    expect(count).toHaveBeenLastCalledWith({
      where: { status: 'queued', session: { tenantId: 't1' } },
    });
  });

  it('loadSnapshot 返回入队快照，缺失或为空时抛 NotFoundException', async () => {
    const input = { goal: '目标', messages: [], traceId: null };
    ctx.db.tasks.push({ id: 'task1', input });
    await expect(svc.loadSnapshot('task1')).resolves.toEqual(input);

    await expect(svc.loadSnapshot('missing')).rejects.toBeInstanceOf(NotFoundException);

    ctx.db.tasks.push({ id: 'task2', input: null });
    await expect(svc.loadSnapshot('task2')).rejects.toThrow('task_snapshot_missing');
  });
});
