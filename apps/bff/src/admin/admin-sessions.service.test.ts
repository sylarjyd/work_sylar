import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminSessionsService } from './admin-sessions.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

interface Session {
  id: string;
  title: string;
  status: string;
  tenantId: string;
  userId: string;
  createdAt: Date;
  user: { email: string };
  _count: { messages: number; tasks: number };
}

interface SessionWhere {
  tenantId?: string;
  userId?: string;
  status?: string;
  title?: { contains?: string };
}

function matches(session: Session, where: SessionWhere = {}): boolean {
  return (
    (where.tenantId === undefined || session.tenantId === where.tenantId) &&
    (where.userId === undefined || session.userId === where.userId) &&
    (where.status === undefined || session.status === where.status) &&
    (where.title?.contains === undefined ||
      session.title.toLowerCase().includes(where.title.contains.toLowerCase()))
  );
}

function makeService(seedArchived = false) {
  const session: Session = {
    id: 's1', title: '季度汇报', status: seedArchived ? 'archived' : 'active',
    tenantId: 't1', userId: 'u1', createdAt: new Date('2026-10-01T00:00:00Z'),
    user: { email: 'u1@test.local' },
    _count: { messages: 4, tasks: 2 },
  };
  const audits: unknown[] = [];
  const db = {
    session: {
      findMany: async ({ where }: { where?: SessionWhere } = {}) =>
        [session].filter((row) => matches(row, where)),
      count: async ({ where }: { where?: SessionWhere } = {}) =>
        [session].filter((row) => matches(row, where)).length,
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
  };
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminSessionsService(db as unknown as PrismaService, audit), audits, session, db };
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
    // 审计只记分页范围，不含消息正文。
    expect(audits[0]).toMatchObject({ action: 'messages.view', targetId: 's1' });
    expect(audits[0]).not.toHaveProperty('content');
    expect((audits[0] as { summary: unknown }).summary).toEqual({ page: 1, pageSize: 20 });
  });

  it('messages 会话不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.messages('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list 按 status 过滤，status=archived 返回归档会话', async () => {
    const { svc } = makeService(true);
    const page = await svc.list({ status: 'archived' });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: 's1', status: 'archived' });

    const active = await svc.list({ status: 'active' });
    expect(active.total).toBe(0);
  });

  it('list 非法 status 抛 400 invalid_status', async () => {
    const { svc } = makeService();
    await expect(svc.list({ status: 'deleted' })).rejects.toMatchObject({
      message: 'invalid_status',
    });
    await expect(svc.list({ status: 'deleted' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('archive 归档并记 session.archive', async () => {
    const { svc, audits, session } = makeService();
    await svc.archive('s1', actor);
    expect(session.status).toBe('archived');
    expect(audits[0]).toMatchObject({ action: 'session.archive', targetId: 's1' });
  });

  it('archive 遇并发删除（P2025）转 404', async () => {
    const { svc, db } = makeService();
    db.session.update = async () => {
      throw Object.assign(new Error('not found'), { code: 'P2025' });
    };
    await expect(svc.archive('s1', actor)).rejects.toMatchObject({
      message: 'session_not_found',
    });
  });

  it('会话不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
