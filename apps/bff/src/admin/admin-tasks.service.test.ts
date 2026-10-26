import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminTasksService } from './admin-tasks.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';
import type { RunsService } from '../runs/runs.service';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

interface StepSeed {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: Date;
}

interface RunSeed {
  id: string;
  taskId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  attempt?: number;
  cancelRequestedAt?: Date | null;
  traceId?: string | null;
  steps: StepSeed[];
}

interface TaskSeed {
  id: string;
  sessionId: string;
  goal: string;
  status: string;
  createdAt: Date;
  attempts?: number;
  queuedAt?: Date;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

interface UsageSeed {
  runId: string;
  credits: number | null;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  models?: unknown;
}

interface SessionSeed {
  tenantId: string;
  userId: string;
}

interface Fixtures {
  tasks?: TaskSeed[];
  runs?: RunSeed[];
  usage?: UsageSeed[];
  sessions?: Record<string, SessionSeed>;
}

const defaultTask: TaskSeed = {
  id: 'task1',
  sessionId: 's1',
  goal: 'x'.repeat(300),
  status: 'done',
  createdAt: new Date('2026-10-01T00:00:00Z'),
};

const defaultRun: RunSeed = {
  id: 'r1',
  taskId: 'task1',
  status: 'done',
  startedAt: new Date('2026-10-01T00:00:00Z'),
  endedAt: new Date('2026-10-01T00:01:00Z'),
  attempt: 1,
  cancelRequestedAt: null,
  traceId: '0af7651916cd43dd8448eb211c80319c',
  steps: [
    { id: 'st1', seq: 0, type: 'think', payload: { text: 'hi' }, ts: new Date('2026-10-01T00:00:01Z') },
  ],
};

/** 内存 fake：findMany/count 按 where 真实过滤，便于验证过滤条件确实下发。 */
function makeService(fixtures: Fixtures = {}) {
  const tasks = fixtures.tasks ?? [defaultTask];
  const runs = fixtures.runs ?? [defaultRun];
  const usage = fixtures.usage ?? [{ runId: 'r1', credits: 7 }];
  const sessions = fixtures.sessions ?? { s1: { tenantId: 't1', userId: 'u1' } };
  const audits: unknown[] = [];

  const runsOfTask = (taskId: string) =>
    runs
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const taskView = (task: TaskSeed) => ({
    ...task,
    runs: runsOfTask(task.id).slice(0, 1).map((r) => ({ status: r.status })),
  });

  const matchTask = (task: TaskSeed, where: any) => {
    if (where?.sessionId && task.sessionId !== where.sessionId) return false;
    if (where?.status && task.status !== where.status) return false;
    const sessionWhere = where?.session?.is;
    if (sessionWhere) {
      const session = sessions[task.sessionId];
      if (sessionWhere.tenantId && session?.tenantId !== sessionWhere.tenantId) return false;
      if (sessionWhere.userId && session?.userId !== sessionWhere.userId) return false;
    }
    return true;
  };

  const usageView = (u: UsageSeed) => ({
    runId: u.runId,
    credits: u.credits,
    inputTokens: u.inputTokens ?? 10,
    outputTokens: u.outputTokens ?? 20,
    status: u.status ?? 'settled',
    models: u.models ?? [],
  });

  const db = {
    task: {
      findMany: async ({ where, skip = 0, take = tasks.length }: any) =>
        tasks
          .filter((t) => matchTask(t, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(skip, skip + take)
          .map(taskView),
      count: async ({ where }: any) => tasks.filter((t) => matchTask(t, where)).length,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const task = tasks.find((t) => t.id === where.id);
        return task ? taskView(task) : null;
      },
    },
    run: {
      findMany: async ({ where }: any) => runsOfTask(where.taskId),
      findUnique: async ({ where, include, select }: any) => {
        const run = runs.find((r) => r.id === where.id);
        if (!run) return null;
        // runOwner 只 select attempt 与 task.session，不需要整行与步骤。
        if (select) {
          const task = tasks.find((t) => t.id === run.taskId);
          const session = task ? sessions[task.sessionId] : undefined;
          return { attempt: run.attempt ?? 1, task: { session } };
        }
        const ordered = [...run.steps].sort((a, b) => a.seq - b.seq);
        const skip = include?.steps?.skip ?? 0;
        const take = include?.steps?.take ?? ordered.length;
        return {
          ...run,
          attempt: run.attempt ?? 1,
          steps: ordered.slice(skip, skip + take),
          _count: { steps: ordered.length },
        };
      },
    },
    usageRecord: {
      findMany: async ({ where }: any) =>
        usage.filter((u) => where.runId.in.includes(u.runId)).map(usageView),
      findUnique: async ({ where }: { where: { runId: string } }) => {
        const u = usage.find((x) => x.runId === where.runId);
        return u ? usageView(u) : null;
      },
    },
  } as unknown as PrismaService;
  const audit = {
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    record: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;

  const runCalls: {
    cancel: Array<{ runId: string; tenantId: string; userId: string }>;
    retry: Array<{ runId: string; tenantId: string; userId: string }>;
  } = { cancel: [], retry: [] };
  const runsService = {
    cancel: async (runId: string, tenantId: string, userId: string) => {
      runCalls.cancel.push({ runId, tenantId, userId });
      return { status: 'canceled' as const };
    },
    retry: async (runId: string, tenantId: string, userId: string) => {
      runCalls.retry.push({ runId, tenantId, userId });
      return { runId: 'r2', taskId: 'task1', attempt: 2 };
    },
  } as unknown as RunsService;

  return { svc: new AdminTasksService(db, audit, runsService), audits, runCalls };
}

describe('AdminTasksService', () => {
  it('list 目标截断 200 字并带最近运行状态', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0].goal).toHaveLength(200);
    expect(page.items[0].latestRunStatus).toBe('done');
  });

  it('list 截断按码点计算，不切裂 emoji', async () => {
    const { svc } = makeService({
      tasks: [{ ...defaultTask, goal: 'a'.repeat(199) + '😀'.repeat(10) }],
    });
    const page = await svc.list({});
    const goal = page.items[0].goal;
    expect(Array.from(goal)).toHaveLength(200);
    expect(goal.endsWith('😀')).toBe(true);
  });

  it('list status 过滤生效', async () => {
    const { svc } = makeService();
    const failed = await svc.list({ status: 'failed' });
    expect(failed.items).toHaveLength(0);
    expect(failed.total).toBe(0);

    const done = await svc.list({ status: 'done' });
    expect(done.items).toHaveLength(1);
    expect(done.total).toBe(1);
  });

  it('list 接受 queued 并拒绝非法 status', async () => {
    const { svc } = makeService();
    await expect(svc.list({ status: 'queued' })).resolves.toMatchObject({ total: 0 });
    await expect(svc.list({ status: 'archived' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('detail 返回运行与积分', async () => {
    const { svc, audits } = makeService();
    const detail = await svc.detail('task1', actor);
    expect(detail.runs[0]).toMatchObject({ id: 'r1', credits: 7 });
    expect(audits[0]).toMatchObject({ action: 'task.view', targetId: 'task1' });
  });

  it('detail 在无 run 或无 usage 时摘要为 null', async () => {
    const noRun = makeService({ runs: [], usage: [] });
    const detailWithoutRun = await noRun.svc.detail('task1', actor);
    expect(detailWithoutRun.latestRunStatus).toBeNull();
    expect(detailWithoutRun.runs).toHaveLength(0);

    const noUsage = makeService({ usage: [] });
    const detailWithoutUsage = await noUsage.svc.detail('task1', actor);
    expect(detailWithoutUsage.runs[0].credits).toBeNull();
  });

  it('runDetail 返回分页 step 与用量', async () => {
    const { svc, audits } = makeService();
    const detail = await svc.runDetail('r1', { stepPage: '1', stepPageSize: '20' }, actor);
    expect(detail.steps.items[0]).toMatchObject({ seq: 0, type: 'think' });
    expect(detail.usage).toMatchObject({ credits: 7, status: 'settled' });
    expect(audits[0]).toMatchObject({ action: 'run.view', targetId: 'r1' });
  });

  it('runDetail stepPageSize 非法抛 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.runDetail('r1', { stepPageSize: '0' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.runDetail('r1', { stepPageSize: '101' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.runDetail('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('runDetail 回传 traceId，历史数据为 null', async () => {
    const { svc } = makeService();
    const detail = await svc.runDetail('r1', {}, actor);
    expect(detail.traceId).toBe('0af7651916cd43dd8448eb211c80319c');

    const legacy = makeService({ runs: [{ ...defaultRun, traceId: null }] });
    await expect(legacy.svc.runDetail('r1', {}, actor)).resolves.toMatchObject({ traceId: null });
  });

  it('runTimeline 聚合节点、回传 traceId 与用量且不泄露正文', async () => {
    const { svc, audits } = makeService({
      runs: [
        {
          ...defaultRun,
          traceId: 'trace-1',
          steps: [
            {
              id: 's1',
              seq: 0,
              type: 'tool_call',
              payload: { tool: 'web.search', input: { q: '敏感入参' } },
              ts: new Date('2026-10-01T00:00:01Z'),
            },
            {
              id: 's2',
              seq: 1,
              type: 'tool_result',
              payload: { tool: 'web.search', ok: true, preview: '敏感结果' },
              ts: new Date('2026-10-01T00:00:03Z'),
            },
          ],
        },
      ],
    });
    const timeline = await svc.runTimeline('r1', actor);
    expect(timeline).toMatchObject({
      runId: 'r1',
      traceId: 'trace-1',
      status: 'done',
      durationMs: 60_000,
      truncated: false,
      usage: { credits: 7 },
    });
    expect(timeline.nodes.map((node) => node.kind)).toEqual(['accepted', 'tool', 'finished']);
    expect(JSON.stringify(timeline)).not.toContain('敏感');
    expect(audits[0]).toMatchObject({ action: 'run.timeline_view', targetId: 'r1' });
  });

  it('runTimeline 超过 500 个 step 时标记 truncated', async () => {
    const { svc } = makeService({
      runs: [
        {
          ...defaultRun,
          steps: Array.from({ length: 501 }, (_, index) => ({
            id: `s${index}`,
            seq: index,
            type: 'think',
            payload: {},
            ts: new Date('2026-10-01T00:00:01Z'),
          })),
        },
      ],
    });
    const timeline = await svc.runTimeline('r1', actor);
    expect(timeline.truncated).toBe(true);
    expect(timeline.nodes.length).toBeLessThanOrEqual(500);
    expect(timeline.nodes[timeline.nodes.length - 1].kind).toBe('notice');
  });

  it('runTimeline 不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.runTimeline('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('列表支持 queued/canceled 并可返回 attempts 与排队时间', async () => {
    const queuedAt = new Date('2026-10-02T00:00:00Z');
    const { svc } = makeService({
      tasks: [
        {
          ...defaultTask,
          id: 'task-queued',
          status: 'queued',
          attempts: 1,
          queuedAt,
          startedAt: null,
          endedAt: null,
        },
        {
          ...defaultTask,
          id: 'task-canceled',
          status: 'canceled',
          attempts: 2,
          queuedAt,
          endedAt: new Date('2026-10-02T00:05:00Z'),
        },
      ],
      runs: [
        { ...defaultRun, id: 'r-queued', taskId: 'task-queued', status: 'queued' },
        { ...defaultRun, id: 'r-canceled', taskId: 'task-canceled', status: 'canceled' },
      ],
      usage: [],
    });

    const queued = await svc.list({ status: 'queued' });
    expect(queued.items[0]).toMatchObject({
      status: 'queued',
      latestRunStatus: 'queued',
      attempts: 1,
      queuedAt: queuedAt.toISOString(),
      startedAt: null,
      endedAt: null,
    });

    const canceled = await svc.list({ status: 'canceled' });
    expect(canceled.items[0]).toMatchObject({
      status: 'canceled',
      attempts: 2,
      latestRunStatus: 'canceled',
    });
  });

  it('取消/重试前解析 run 归属，run 不存在抛 404 且不触发副作用', async () => {
    const { svc, runCalls, audits } = makeService();
    await expect(svc.cancelRun('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.retryRun('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(runCalls.cancel).toHaveLength(0);
    expect(runCalls.retry).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('取消运行以目标归属调用领域服务并写审计', async () => {
    const { svc, audits, runCalls } = makeService({
      runs: [{ ...defaultRun, attempt: 4 }],
    });
    const result = await svc.cancelRun('r1', actor);

    expect(result).toEqual({ status: 'canceled' });
    expect(runCalls.cancel[0]).toEqual({ runId: 'r1', tenantId: 't1', userId: 'u1' });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'run.cancel',
        targetType: 'run',
        targetId: 'r1',
        summary: { status: 'canceled', attempt: 4 },
      }),
    );
  });

  it('重试运行写审计并返回新 attempt', async () => {
    const { svc, audits, runCalls } = makeService();
    const result = await svc.retryRun('r1', actor);

    expect(result).toEqual({ runId: 'r2', taskId: 'task1', attempt: 2 });
    expect(runCalls.retry[0]).toEqual({ runId: 'r1', tenantId: 't1', userId: 'u1' });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'run.retry',
        targetType: 'run',
        targetId: 'r1',
        summary: { status: 'queued', attempt: 2, runId: 'r2' },
      }),
    );
  });
});
