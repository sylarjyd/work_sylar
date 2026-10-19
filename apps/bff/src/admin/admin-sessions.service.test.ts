import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AdminSessionsService } from './admin-sessions.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

function makeService(seedArchived = false) {
  const session = {
    id: 's1', title: '季度汇报', status: seedArchived ? 'archived' : 'active',
    tenantId: 't1', userId: 'u1', createdAt: new Date('2026-10-01T00:00:00Z'),
    user: { email: 'u1@test.local' },
    _count: { messages: 4, tasks: 2 },
  };
  const audits: unknown[] = [];
  const db = {
    session: {
      findMany: async () => [session],
      count: async () => 1,
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 's1' ? session : null),
      update: async ({ data }: { data: { status: string } }) => {
        session.status = data.status;
        return session;
      },
    },
    message: {
      findMany: async () => [
        { id: 'm1', role: 'user', content: 'hi', seq: 0, createdAt: new Date('2026-10-01T00:00:00Z') },
      ],
      count: async () => 1,
    },
    task: { count: async () => 2 },
    artifact: { count: async () => 1 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminSessionsService(db, audit), audits, session };
}

describe('AdminSessionsService', () => {
  it('list 返回消息/任务计数', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0]).toMatchObject({ messageCount: 4, taskCount: 2, userEmail: 'u1@test.local' });
  });

  it('messages 按 seq 分页并记 messages.view（不含正文）', async () => {
    const { svc, audits } = makeService();
    const page = await svc.messages('s1', { page: '1', pageSize: '20' }, actor);
    expect(page.items[0]).toMatchObject({ seq: 0, content: 'hi' });
    expect(audits[0]).toMatchObject({ action: 'messages.view', targetId: 's1' });
    expect(JSON.stringify(audits[0])).not.toContain('hi');
  });

  it('archive 归档并记 session.archive', async () => {
    const { svc, audits, session } = makeService();
    await svc.archive('s1', actor);
    expect(session.status).toBe('archived');
    expect(audits[0]).toMatchObject({ action: 'session.archive', targetId: 's1' });
  });

  it('会话不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
