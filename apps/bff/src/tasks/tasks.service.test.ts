import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TasksService } from './tasks.service';
import type { PrismaService } from '../db/prisma.service';

type Row = Record<string, any>;

/** 构造一个最小的内存版 Prisma：只实现任务服务用到的方法。 */
function makeDb() {
  const db = {
    messages: [] as Row[],
    tasks: [] as Row[],
    runs: [] as Row[],
    // 预先排队的 message.create 异常，用来模拟并发唯一键冲突等故障。
    messageCreateErrors: [] as unknown[],
    messageCreateCalls: 0,
    runUpdates: [] as Row[],
    taskUpdates: [] as Row[],
  };

  const sessionMessages = (sessionId: string) => db.messages.filter((m) => m.sessionId === sessionId);

  const client: any = {
    message: {
      findMany: async ({ where }: any) => [...sessionMessages(where.sessionId)].sort((a, b) => a.seq - b.seq),
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
    // 模拟事务回滚：回调抛错时恢复进入事务前的数据快照。
    $transaction: async (fn: any) => {
      const snapshot = {
        messages: [...db.messages],
        tasks: [...db.tasks],
        runs: [...db.runs],
      };
      try {
        return await fn(client);
      } catch (err) {
        db.messages = snapshot.messages;
        db.tasks = snapshot.tasks;
        db.runs = snapshot.runs;
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

describe('TasksService', () => {
  it('prepare 遇到 P2002 后重试，消息序号取当前最大值 +1', async () => {
    ctx.db.messages.push({ id: 'm0', sessionId: 's1', role: 'user', content: '旧消息', seq: 0 });
    ctx.db.messageCreateErrors.push(p2002());

    const result = await svc.prepare('s1', 't1', 'u1', '新目标', 'run1');

    // 首次 create 被注入 P2002 异常后重试成功，仍写 seq 1，不出现空洞或重复。
    expect(result.taskId).toBeTruthy();
    expect(result.runId).toBe('run1');
    expect(ctx.db.messageCreateCalls).toBe(2);
    expect(ctx.db.messages.filter((m) => m.role === 'user').map((m) => m.seq)).toEqual([0, 1]);
    expect(ctx.db.messages.find((m) => m.role === 'user' && m.seq === 1)?.content).toBe('新目标');
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: '新目标' });
    // 首次事务已回滚：重试成功后不应残留第一次创建的 task/run 孤儿。
    expect(ctx.db.tasks).toHaveLength(1);
    expect(ctx.db.runs).toHaveLength(1);
    expect(ctx.db.runs[0].id).toBe('run1');
  });

  it('prepare 只重试 P2002，其他错误立即抛出', async () => {
    const err: any = new Error('fk');
    err.code = 'P2003';
    ctx.db.messageCreateErrors.push(err);

    await expect(svc.prepare('s1', 't1', 'u1', '目标', 'run1')).rejects.toMatchObject({ code: 'P2003' });
    expect(ctx.db.messageCreateCalls).toBe(1);
  });

  it('prepare 重试耗尽后抛出，且所有事务均已回滚', async () => {
    for (let i = 0; i < 5; i++) ctx.db.messageCreateErrors.push(p2002());

    await expect(svc.prepare('s1', 't1', 'u1', '目标', 'run1')).rejects.toMatchObject({ code: 'P2002' });
    expect(ctx.db.messageCreateCalls).toBe(5);
    expect(ctx.db.tasks).toHaveLength(0);
    expect(ctx.db.runs).toHaveLength(0);
  });

  it('prepare 对 runId 等非 seq 的 P2002 不重试，直接抛出', async () => {
    ctx.db.messageCreateErrors.push(p2002(['id']));

    await expect(svc.prepare('s1', 't1', 'u1', '目标', 'run1')).rejects.toMatchObject({ code: 'P2002' });
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
    await svc.prepare('s1', 't1', 'u1', '目标', 'run1', 'trace-1');
    expect(ctx.db.runs[0]).toMatchObject({ id: 'run1', traceId: 'trace-1' });

    await svc.prepare('s1', 't1', 'u1', '目标', 'run2');
    expect(ctx.db.runs[1].traceId).toBeNull();
  });
});
