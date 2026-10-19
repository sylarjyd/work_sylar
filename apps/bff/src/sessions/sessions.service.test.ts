import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import type { PrismaService } from '../db/prisma.service';

const all = [
  { id: 's1', tenantId: 't1', userId: 'u1', title: 'active', status: 'active', createdAt: new Date() },
  { id: 's2', tenantId: 't1', userId: 'u1', title: 'archived', status: 'archived', createdAt: new Date() },
];

function makeService() {
  const prisma = {
    session: {
      findMany: async ({ where }: { where: { tenantId: string; userId: string; status?: { not: string } } }) =>
        all.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            (!where.status?.not || s.status !== where.status.not),
        ),
      findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string; status?: { not: string } } }) =>
        all.find(
          (s) =>
            s.id === where.id &&
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            (!where.status?.not || s.status !== where.status.not),
        ) ?? null,
    },
  } as unknown as PrismaService;
  return new SessionsService(prisma);
}

describe('SessionsService 归档语义', () => {
  it('list 不返回归档会话', async () => {
    const list = await makeService().list('t1', 'u1');
    expect(list.map((s) => s.id)).toEqual(['s1']);
  });

  it('归档会话对普通用户视为不存在', async () => {
    await expect(makeService().assertOwned('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
