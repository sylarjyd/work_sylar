import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import type { PrismaService } from '../db/prisma.service';
import type { RunSnapshot } from '../queue/run-job';

type Row = Record<string, any>;

/**
 * 按 Prisma where 语义匹配内存行：支持等值、in、gte、lt、notIn、not。
 * 多个操作符按「且」组合（如 `{ not: null, lt: before }`）。
 */
function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const op = expected as Record<string, any>;
      if (Array.isArray(op.in) && !op.in.includes(actual)) return false;
      if ('gte' in op && !(actual >= op.gte)) return false;
      if ('lt' in op && !(actual != null && actual < op.lt)) return false;
      if ('notIn' in op && op.notIn.includes(actual)) return false;
      if ('not' in op && actual === op.not) return false;
      // 关系过滤在本内存实现里不参与匹配。
      return true;
    }
    return actual === expected;
  });
}

/** 应用 updateMany 的 data：支持 Prisma 的 increment/decrement 原子操作。 */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in value) {
      row[key] = (row[key] ?? 0) + (value as Row).increment;
    } else if (value !== null && typeof value === 'object' && 'decrement' in value) {
      row[key] = (row[key] ?? 0) - (value as Row).decrement;
    } else {
      row[key] = value;
    }
  }
}

/** 构造一个最小的内存版 Prisma：只实现任务服务用到的方法。 */
function makeDb() {
  const db = {
    messages: [] as Row[],
    tasks: [] as Row[],
    runs: [] as Row[],
    attachments: [] as Row[],
    artifacts: [] as Row[],
    steps: [] as Row[],
    runCheckpoints: [] as Row[],
    // 预先排队的 message.create 异常，用来模拟并发唯一键冲突等故障。
    messageCreateErrors: [] as unknown[],
    messageCreateCalls: 0,
    runUpdates: [] as Row[],
    taskUpdates: [] as Row[],
    // 用例可在条件更新前插入钩子，模拟并发写入导致 CAS 落空。
    hooks: {} as { beforeTaskUpdateMany?: () => void },
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
      // 条件更新：status/runId 等过滤条件按内存行逐项匹配。
      updateMany: async ({ where, data }: any) => {
        db.hooks.beforeTaskUpdateMany?.();
        const rows = db.tasks.filter((t) => matchesWhere(t, where));
        for (const row of rows) applyData(row, data);
        return { count: rows.length };
      },
    },
    run: {
      findFirst: async ({ where }: any) => {
        const row = db.runs.find((r) => r.id === where.id);
        const session = where.task?.session;
        if (!row) return null;
        if (session && (row.tenantId !== session.tenantId || row.userId !== session.userId)) {
          return null;
        }
        return {
          id: row.id,
          taskId: row.taskId,
          status: row.status,
          cancelRequestedAt: row.cancelRequestedAt ?? null,
        };
      },
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
      updateMany: async ({ where, data }: any) => {
        const rows = db.runs.filter((r) => matchesWhere(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      // 恢复扫描用：where 过滤 + startedAt/cancelRequestedAt 升序 + take；
      // select 决定返回列，sessionId 通过 task 关系回填（对齐 Prisma 的形状）。
      findMany: async ({ where, orderBy, take, select }: any) => {
        let rows = db.runs.filter((r) => matchesWhere(r, where));
        const field = orderBy?.startedAt
          ? 'startedAt'
          : orderBy?.cancelRequestedAt
            ? 'cancelRequestedAt'
            : null;
        if (field) rows = [...rows].sort((a, b) => a[field] - b[field]);
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((r) => {
          const row: Row = {};
          if (!select || select.id) row.id = r.id;
          if (!select || select.taskId) row.taskId = r.taskId;
          if (!select || select.startedAt) row.startedAt = r.startedAt ?? null;
          if (!select || select.cancelRequestedAt) row.cancelRequestedAt = r.cancelRequestedAt ?? null;
          if (select?.task) {
            row.task = { sessionId: db.tasks.find((t) => t.id === r.taskId)?.sessionId };
          }
          return row;
        });
      },
    },
    step: {
      deleteMany: async ({ where }: any) => {
        const rows = db.steps.filter((s) => matchesWhere(s, where));
        db.steps = db.steps.filter((s) => !rows.includes(s));
        return { count: rows.length };
      },
    },
    runCheckpoint: {
      findUnique: async ({ where }: any) =>
        db.runCheckpoints.find((c) => c.runId === where.runId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const row = db.runCheckpoints.find((c) => c.runId === where.runId);
        if (row) {
          Object.assign(row, update);
          return row;
        }
        const created = { runId: where.runId, ...create, updatedAt: new Date() };
        db.runCheckpoints.push(created);
        return created;
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
      findMany: async ({ where }: any) =>
        db.attachments.filter((a) => a.messageId === where.messageId),
    },
    artifact: {
      findMany: async ({ where }: any) =>
        db.artifacts.filter((a) => a.runId === where.runId).map((a) => ({ id: a.id })),
      deleteMany: async ({ where }: any) => {
        const rows = db.artifacts.filter((a) => matchesWhere(a, where));
        db.artifacts = db.artifacts.filter((a) => !rows.includes(a));
        return { count: rows.length };
      },
    },
    // 模拟事务：数组形式直接并行执行（调用方已把操作构造成 Promise）；
    // 回调形式在抛错时恢复进入事务前的数据快照。
    $transaction: async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      const snapshot = {
        messages: [...db.messages],
        // 深度克隆：updateMany 会就地改写行对象，浅拷贝无法还原回滚。
        tasks: db.tasks.map((t) => ({ ...t })),
        runs: db.runs.map((r) => ({ ...r })),
        attachments: db.attachments.map((a) => ({ ...a })),
      };
      try {
        return await arg(client);
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

  it('findOwnedRun 返回本人的 run，缺失或他人一律 404', async () => {
    const at = new Date();
    ctx.db.runs.push({
      id: 'r1',
      taskId: 'task1',
      status: 'running',
      tenantId: 't1',
      userId: 'u1',
      cancelRequestedAt: at,
    });

    await expect(svc.findOwnedRun('r1', 't1', 'u1')).resolves.toEqual({
      id: 'r1',
      taskId: 'task1',
      status: 'running',
      cancelRequestedAt: at,
    });
    await expect(svc.findOwnedRun('missing', 't1', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // 他人 / 他租户一律 404，不泄露存在性。
    await expect(svc.findOwnedRun('r1', 't1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.findOwnedRun('r1', 't2', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('markCanceled 同时把 run/task 原子置为 canceled', async () => {
    ctx.db.runs.push({ id: 'r1', taskId: 'task1', status: 'queued' });
    ctx.db.tasks.push({ id: 'task1', status: 'queued' });

    await expect(svc.markCanceled('r1', 'task1')).resolves.toBe(true);

    expect(ctx.db.runs[0]).toMatchObject({ status: 'canceled' });
    expect(ctx.db.runs[0].endedAt).toBeInstanceOf(Date);
    expect(ctx.db.tasks[0]).toMatchObject({ status: 'canceled' });
    expect(ctx.db.tasks[0].endedAt).toBeInstanceOf(Date);
  });

  it('markCanceled 在 run 已非 queued 时返回 false 且不动 task', async () => {
    ctx.db.runs.push({ id: 'r1', taskId: 'task1', status: 'running' });
    ctx.db.tasks.push({ id: 'task1', status: 'queued' });

    await expect(svc.markCanceled('r1', 'task1')).resolves.toBe(false);
    expect(ctx.db.runs[0].status).toBe('running');
    expect(ctx.db.tasks[0].status).toBe('queued');
  });

  it('markCanceled 在 task 已非 queued 时抛错并回滚 run 更新', async () => {
    ctx.db.runs.push({ id: 'r1', taskId: 'task1', status: 'queued' });
    ctx.db.tasks.push({ id: 'task1', status: 'running' });

    // task 与 run 状态撕裂属于数据不一致：不能静默返回 false，必须上抛让调用方感知。
    await expect(svc.markCanceled('r1', 'task1')).rejects.toThrow('task_not_queued');
    // task 未能同步取消时必须回滚 run，避免出现 run canceled / task running 的撕裂状态。
    expect(ctx.db.runs[0]).toMatchObject({ status: 'queued' });
    expect(ctx.db.runs[0].endedAt).toBeUndefined();
    expect(ctx.db.tasks[0].status).toBe('running');
  });

  it('markCancelRequested 接受 queued 与 running，返回首次写入行数且忽略已终态的 run', async () => {
    // 执行器可能已取走作业但还没写 running：只匹配 running 会静默丢弃这次取消。
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const conditional = new TasksService({ run: { updateMany } } as any, sessions as any);

    // 0 行时返回 0，不抛错。
    await expect(conditional.markCancelRequested('r1')).resolves.toBe(0);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'r1',
        status: { in: ['queued', 'running'] },
        // 条件带 null 才能既避免覆盖首次请求时间，又让调用方区分首次/重复取消。
        cancelRequestedAt: null,
      },
      data: { cancelRequestedAt: expect.any(Date) },
    });

    ctx.db.runs.push(
      { id: 'r1', status: 'queued', cancelRequestedAt: null },
      { id: 'r2', status: 'running', cancelRequestedAt: null },
      { id: 'r3', status: 'done', cancelRequestedAt: null },
    );
    // queued/running 首次取消写入 1 行，已终态 0 行。
    await expect(svc.markCancelRequested('r1')).resolves.toBe(1);
    await expect(svc.markCancelRequested('r2')).resolves.toBe(1);
    await expect(svc.markCancelRequested('r3')).resolves.toBe(0);
    expect(ctx.db.runs[0].cancelRequestedAt).toBeInstanceOf(Date);
    expect(ctx.db.runs[1].cancelRequestedAt).toBeInstanceOf(Date);
    expect(ctx.db.runs[2].cancelRequestedAt).toBeNull();

    // 同一 run 再次请求返回 0，且首次请求时间不被覆盖。
    const first = ctx.db.runs[0].cancelRequestedAt;
    await expect(svc.markCancelRequested('r1')).resolves.toBe(0);
    expect(ctx.db.runs[0].cancelRequestedAt).toBe(first);
  });

  it('finish 支持 canceled：run/task 均落 canceled 且不写 assistant 消息', async () => {
    ctx.db.runs.push({ id: 'run1', taskId: 'task1', status: 'running' });
    ctx.db.tasks.push({ id: 'task1', status: 'running' });

    await svc.finish('run1', 'task1', 'canceled', '', 's1');

    expect(ctx.db.runUpdates[0]).toMatchObject({
      where: { id: 'run1' },
      data: { status: 'canceled' },
    });
    expect(ctx.db.taskUpdates[0]).toMatchObject({
      where: { id: 'task1' },
      data: { status: 'canceled' },
    });
    expect(ctx.db.messages).toHaveLength(0);
  });

  it('saveCheckpoint 覆盖式 upsert，并保存当刻该 run 的全部产物 id', async () => {
    ctx.db.artifacts.push(
      { id: 'a1', runId: 'r1' },
      { id: 'a2', runId: 'r1' },
      { id: 'a-other', runId: 'r2' },
    );
    const deltas = [
      { role: 'assistant', content: '调用', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
      { role: 'tool', content: '结果', toolCallId: 'c1' },
    ];
    const usage = [{ model: 'm1', input: 3, output: 2 }];

    await svc.saveCheckpoint('r1', { round: 1, seq: 5, deltas: deltas as any, usage });

    expect(ctx.db.runCheckpoints).toHaveLength(1);
    expect(ctx.db.runCheckpoints[0]).toMatchObject({
      runId: 'r1',
      round: 1,
      seq: 5,
      deltas,
      usage,
      artifactIds: ['a1', 'a2'],
    });

    // 第二次保存覆盖同一行：deltas 是累计值，绝不能追加成两行/两份历史。
    ctx.db.artifacts.push({ id: 'a3', runId: 'r1' });
    const next = [{ role: 'assistant', content: '终稿' }];
    await svc.saveCheckpoint('r1', { round: 2, seq: 9, deltas: next as any, usage });

    expect(ctx.db.runCheckpoints).toHaveLength(1);
    expect(ctx.db.runCheckpoints[0]).toMatchObject({
      round: 2,
      seq: 9,
      deltas: next,
      artifactIds: ['a1', 'a2', 'a3'],
    });
  });

  it('getCheckpoint 返回最近断点，缺失时为 null', async () => {
    await expect(svc.getCheckpoint('r1')).resolves.toBeNull();

    ctx.db.runCheckpoints.push({
      runId: 'r1',
      round: 2,
      seq: 9,
      deltas: [],
      usage: [],
      artifactIds: [],
    });
    await expect(svc.getCheckpoint('r1')).resolves.toMatchObject({ round: 2, seq: 9 });
  });

  it('truncateForResume 删除断点之后的步骤与清单外产物', async () => {
    ctx.db.steps.push(
      { id: 's0', runId: 'r1', seq: 0 },
      { id: 's1', runId: 'r1', seq: 1 },
      { id: 's2', runId: 'r1', seq: 2 },
      { id: 's3', runId: 'r1', seq: 3 },
      { id: 'x0', runId: 'r2', seq: 0 },
    );
    ctx.db.artifacts.push(
      { id: 'a1', runId: 'r1' },
      { id: 'a2', runId: 'r1' },
      { id: 'other', runId: 'r2' },
    );

    await svc.truncateForResume('r1', { seq: 2, artifactIds: ['a1'] });

    expect(ctx.db.steps.filter((s) => s.runId === 'r1').map((s) => s.seq)).toEqual([0, 1]);
    expect(ctx.db.artifacts.filter((a) => a.runId === 'r1').map((a) => a.id)).toEqual(['a1']);
    // 其他 run 的步骤/产物不受影响。
    expect(ctx.db.steps.find((s) => s.id === 'x0')).toBeDefined();
    expect(ctx.db.artifacts.find((a) => a.id === 'other')).toBeDefined();
  });

  it('truncateForResume 对非数组/非字符串 artifactIds 容错，按空清单清理', async () => {
    ctx.db.artifacts.push({ id: 'a1', runId: 'r1' }, { id: 'a2', runId: 'r1' });

    // JSON 列历史数据可能损坏：非数组按空清单处理（宁可多删也不留半轮产物）。
    await svc.truncateForResume('r1', { seq: 0, artifactIds: 'broken' });
    expect(ctx.db.artifacts.filter((a) => a.runId === 'r1')).toHaveLength(0);

    // 数组中的非字符串条目必须被丢弃，不能拼进 notIn 造成误删/错删。
    ctx.db.artifacts.push({ id: 'a1', runId: 'r1' }, { id: 'a2', runId: 'r1' });
    await svc.truncateForResume('r1', { seq: 0, artifactIds: ['a1', 42, null] });
    expect(ctx.db.artifacts.filter((a) => a.runId === 'r1').map((a) => a.id)).toEqual(['a1']);
  });

  it('markRunning 条件推进 queued→running，重试时 0 行不抛错且保留 startedAt', async () => {
    ctx.db.runs.push({ id: 'r1', status: 'queued' });
    ctx.db.tasks.push({ id: 'task1', status: 'queued' });

    await svc.markRunning('r1', 'task1');
    expect(ctx.db.runs[0]).toMatchObject({ status: 'running' });
    expect(ctx.db.runs[0].startedAt).toBeInstanceOf(Date);
    expect(ctx.db.tasks[0]).toMatchObject({ status: 'running' });
    expect(ctx.db.tasks[0].startedAt).toBeInstanceOf(Date);

    // 第二次调用两行都已是 running：条件更新 0 行属于正常，且不改写首次开始时间。
    const startedAt = ctx.db.runs[0].startedAt;
    await expect(svc.markRunning('r1', 'task1')).resolves.toBeUndefined();
    expect(ctx.db.runs[0].startedAt).toBe(startedAt);
  });

  it('createRetryRun 复用快照创建 attempt+1 的 run 并重置任务字段', async () => {
    ctx.db.tasks.push({
      id: 'task1',
      sessionId: 's1',
      status: 'failed',
      attempts: 1,
      input: { goal: '目标', messages: [] },
      lastError: 'boom',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const result = await svc.createRetryRun('task1', 'trace-2');

    expect(result).toEqual({ runId: 'run1', taskId: 'task1', sessionId: 's1', attempt: 2 });
    expect(ctx.db.tasks[0]).toMatchObject({
      status: 'queued',
      // attempts 自增而不是重置为 1：重试次数要累计到任务上。
      attempts: 2,
      lastError: null,
      startedAt: null,
      endedAt: null,
    });
    expect(ctx.db.runs[0]).toMatchObject({
      id: 'run1',
      taskId: 'task1',
      attempt: 2,
      status: 'queued',
      traceId: 'trace-2',
    });
    // 开始时间由执行器在真正启动时写入。
    expect(ctx.db.runs[0].startedAt).toBeUndefined();
    // 快照复用原 Task.input，不复制到新 run。
    expect(ctx.db.tasks[0].input).toEqual({ goal: '目标', messages: [] });
  });

  it('createRetryRun 同样接受 canceled 任务', async () => {
    ctx.db.tasks.push({
      id: 'task1',
      sessionId: 's1',
      status: 'canceled',
      attempts: 0,
      input: { goal: '目标' },
    });

    await expect(svc.createRetryRun('task1', null)).resolves.toMatchObject({ attempt: 1 });
    expect(ctx.db.tasks[0]).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('createRetryRun 并发重试 CAS 落空时抛 task_busy，且不新建 run', async () => {
    ctx.db.tasks.push({
      id: 'task1',
      sessionId: 's1',
      status: 'failed',
      attempts: 1,
      input: { goal: '目标' },
    });
    // 模拟另一个请求在读到 attempts 之后先完成了重试。
    ctx.db.hooks.beforeTaskUpdateMany = () => {
      ctx.db.tasks[0].attempts = 2;
    };

    await expect(svc.createRetryRun('task1', null)).rejects.toThrow('task_busy');
    expect(ctx.db.runs).toHaveLength(0);
  });

  it('createRetryRun 任务缺失或快照为空时抛 task_snapshot_missing', async () => {
    await expect(svc.createRetryRun('missing', null)).rejects.toThrow('task_snapshot_missing');

    ctx.db.tasks.push({
      id: 'task1',
      sessionId: 's1',
      status: 'failed',
      attempts: 0,
      input: null,
    });
    await expect(svc.createRetryRun('task1', null)).rejects.toThrow('task_snapshot_missing');
    expect(ctx.db.runs).toHaveLength(0);
  });

  it('createRetryRun 只接受 failed/canceled，其它状态抛 task_not_retryable', async () => {
    for (const status of ['queued', 'running', 'done']) {
      ctx.db.tasks.push({
        id: `task-${status}`,
        sessionId: 's1',
        status,
        attempts: 1,
        input: { goal: '目标' },
      });
      await expect(svc.createRetryRun(`task-${status}`, null)).rejects.toThrow(
        'task_not_retryable',
      );
    }
    expect(ctx.db.runs).toHaveLength(0);
  });

  it('failStaleRun 抢到 running 时把 run/task 一并收尾为 failed', async () => {
    ctx.db.runs.push({ id: 'r1', taskId: 'task1', status: 'running' });
    ctx.db.tasks.push({ id: 'task1', status: 'running' });

    await expect(svc.failStaleRun('r1', 'task1', 'worker_lost')).resolves.toBe(true);

    expect(ctx.db.runs[0]).toMatchObject({ status: 'failed' });
    expect(ctx.db.runs[0].endedAt).toBeInstanceOf(Date);
    expect(ctx.db.tasks[0]).toMatchObject({ status: 'failed', lastError: 'worker_lost' });
    expect(ctx.db.tasks[0].endedAt).toBeInstanceOf(Date);
  });

  it('failStaleRun 在 run 已终态时返回 false，且不改写已正常结束的 task', async () => {
    ctx.db.runs.push({ id: 'r1', taskId: 'task1', status: 'done' });
    ctx.db.tasks.push({ id: 'task1', status: 'running' });

    await expect(svc.failStaleRun('r1', 'task1', 'worker_lost')).resolves.toBe(false);
    expect(ctx.db.runs[0].status).toBe('done');
    // 条件更新落空后绝不能再动 task，否则会把并发收尾的结果覆盖成 failed。
    expect(ctx.db.tasks[0].status).toBe('running');
    expect(ctx.db.tasks[0].lastError).toBeUndefined();
  });

  it('failQueuedAttempt 只回收仍排队的 run/task，返回 true', async () => {
    ctx.db.runs.push({ id: 'r2', taskId: 'task1', status: 'queued' });
    ctx.db.tasks.push({ id: 'task1', status: 'queued' });

    await expect(svc.failQueuedAttempt('r2', 'task1')).resolves.toBe(true);

    expect(ctx.db.runs[0]).toMatchObject({ status: 'failed' });
    expect(ctx.db.runs[0].endedAt).toBeInstanceOf(Date);
    expect(ctx.db.tasks[0]).toMatchObject({ status: 'failed', lastError: 'enqueue_failed' });
  });

  it('failQueuedAttempt 在 run 已被 worker 接手后返回 false，不改写进行中的行', async () => {
    ctx.db.runs.push({ id: 'r2', taskId: 'task1', status: 'running' });
    ctx.db.tasks.push({ id: 'task1', status: 'running' });

    await expect(svc.failQueuedAttempt('r2', 'task1')).resolves.toBe(false);
    // 入队响应丢失但作业已写入 Redis：worker 可能已在执行或已完成，回滚必须让路。
    expect(ctx.db.runs[0].status).toBe('running');
    expect(ctx.db.tasks[0].status).toBe('running');
    expect(ctx.db.tasks[0].lastError).toBeUndefined();
  });

  it('listStaleRunningRuns 按 status/startedAt 过滤，升序并受 limit 约束', async () => {
    const before = new Date('2026-10-26T11:45:00Z');
    ctx.db.tasks.push(
      { id: 'task-old', sessionId: 's1' },
      { id: 'task-old2', sessionId: 's4' },
      { id: 'task-recent', sessionId: 's2' },
      { id: 'task-null', sessionId: 's3' },
    );
    ctx.db.runs.push(
      { id: 'r-old2', taskId: 'task-old2', status: 'running', startedAt: new Date('2026-10-26T11:30:00Z') },
      { id: 'r-old', taskId: 'task-old', status: 'running', startedAt: new Date('2026-10-26T11:00:00Z') },
      { id: 'r-recent', taskId: 'task-recent', status: 'running', startedAt: new Date('2026-10-26T11:59:00Z') },
      { id: 'r-null', taskId: 'task-null', status: 'running', startedAt: null },
      { id: 'r-done', taskId: 'task-old', status: 'done', startedAt: new Date('2026-10-26T10:00:00Z') },
    );

    await expect(svc.listStaleRunningRuns(before)).resolves.toEqual([
      { id: 'r-old', taskId: 'task-old', sessionId: 's1', startedAt: new Date('2026-10-26T11:00:00Z') },
      { id: 'r-old2', taskId: 'task-old2', sessionId: 's4', startedAt: new Date('2026-10-26T11:30:00Z') },
    ]);
    // 只取最旧的 limit 条，避免一次扫描打爆数据库。
    await expect(svc.listStaleRunningRuns(before, 1)).resolves.toEqual([
      { id: 'r-old', taskId: 'task-old', sessionId: 's1', startedAt: new Date('2026-10-26T11:00:00Z') },
    ]);
  });

  it('listStaleCancelRequests 按 status/cancelRequestedAt 过滤，升序并受 limit 约束', async () => {
    const before = new Date('2026-10-26T12:00:00Z');
    ctx.db.runs.push(
      { id: 'r-old2', status: 'running', cancelRequestedAt: new Date('2026-10-26T11:58:00Z') },
      { id: 'r-old', status: 'running', cancelRequestedAt: new Date('2026-10-26T11:55:00Z') },
      { id: 'r-recent', status: 'running', cancelRequestedAt: new Date('2026-10-26T12:00:30Z') },
      { id: 'r-null', status: 'running', cancelRequestedAt: null },
      { id: 'r-done', status: 'done', cancelRequestedAt: new Date('2026-10-26T10:00:00Z') },
    );

    await expect(svc.listStaleCancelRequests(before)).resolves.toEqual([
      { id: 'r-old' },
      { id: 'r-old2' },
    ]);
    await expect(svc.listStaleCancelRequests(before, 1)).resolves.toEqual([{ id: 'r-old' }]);
  });
});
