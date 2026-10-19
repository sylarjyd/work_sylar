import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AdminTasksService } from './admin-tasks.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

function makeService() {
  const task = {
    id: 'task1',
    sessionId: 's1',
    goal: 'x'.repeat(300),
    status: 'done',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    runs: [{ status: 'done' }],
  };
  const run = {
    id: 'r1',
    taskId: 'task1',
    status: 'done',
    startedAt: new Date('2026-10-01T00:00:00Z'),
    endedAt: new Date('2026-10-01T00:01:00Z'),
    steps: [
      { id: 'st1', seq: 0, type: 'think', payload: { text: 'hi' }, ts: new Date('2026-10-01T00:00:01Z') },
    ],
    _count: { steps: 1 },
  };
  const audits: unknown[] = [];
  const db = {
    task: {
      findMany: async () => [task],
      count: async () => 1,
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'task1' ? task : null),
    },
    run: {
      findMany: async () => [run],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'r1' ? run : null),
    },
    usageRecord: {
      findMany: async () => [{ runId: 'r1', credits: 7 }],
      findUnique: async ({ where }: { where: { runId: string } }) =>
        where.runId === 'r1'
          ? { inputTokens: 10, outputTokens: 20, credits: 7, status: 'settled', models: [] }
          : null,
    },
  } as unknown as PrismaService;
  const audit = {
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminTasksService(db, audit), audits };
}

describe('AdminTasksService', () => {
  it('list 目标截断 200 字并带最近运行状态', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0].goal).toHaveLength(200);
    expect(page.items[0].latestRunStatus).toBe('done');
  });

  it('detail 返回运行与积分', async () => {
    const { svc, audits } = makeService();
    const detail = await svc.detail('task1', actor);
    expect(detail.runs[0]).toMatchObject({ id: 'r1', credits: 7 });
    expect(audits[0]).toMatchObject({ action: 'task.view', targetId: 'task1' });
  });

  it('runDetail 返回分页 step 与用量', async () => {
    const { svc, audits } = makeService();
    const detail = await svc.runDetail('r1', { stepPage: '1', stepPageSize: '20' }, actor);
    expect(detail.steps.items[0]).toMatchObject({ seq: 0, type: 'think' });
    expect(detail.usage).toMatchObject({ credits: 7, status: 'settled' });
    expect(audits[0]).toMatchObject({ action: 'run.view', targetId: 'r1' });
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
