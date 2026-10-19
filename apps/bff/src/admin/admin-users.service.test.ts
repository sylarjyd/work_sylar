import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'admin1', email: 'admin@test.local' };

interface Row {
  id: string;
  email: string;
  tenantId: string;
  role: string;
  status: string;
  createdAt: Date;
  tenant: { name: string };
}

function makeService(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  const audits: unknown[] = [];
  const db = {
    user: {
      findMany: async () => rows,
      // 模拟 where 过滤：最后一个管理员用例依赖 id.not / role / status 条件。
      count: async ({
        where,
      }: {
        where?: { id?: { not?: string }; role?: string; status?: string };
      } = {}) =>
        rows.filter(
          (r) =>
            (where?.id?.not === undefined || r.id !== where.id.not) &&
            (where?.role === undefined || r.role === where.role) &&
            (where?.status === undefined || r.status === where.status),
        ).length,
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    subscription: { findUnique: async () => null },
    tenantCredit: { findUnique: async () => null },
    session: { count: async () => 3 },
    adminAuditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
        return {};
      },
    },
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
  return { svc: new AdminUsersService(db, audit), rows, audits };
}

function user(overrides: Partial<Row> = {}): Row {
  return {
    id: 'u1',
    email: 'u1@test.local',
    tenantId: 't1',
    role: 'member',
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    tenant: { name: '个人空间' },
    ...overrides,
  };
}

describe('AdminUsersService', () => {
  it('list 返回分页结构', async () => {
    const { svc } = makeService([user()]);
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ email: 'u1@test.local', tenantName: '个人空间' });
  });

  it('detail 返回计费摘要与会话数并记 user.view', async () => {
    const { svc, audits } = makeService([user()]);
    const detail = await svc.detail('u1', actor);
    expect(detail).toMatchObject({ sessionCount: 3, balance: 0, reserved: 0 });
    expect(audits[0]).toMatchObject({ action: 'user.view', targetId: 'u1' });
  });

  it('不能修改自己', async () => {
    const { svc } = makeService([
      user({ id: 'admin1', email: 'admin@test.local', role: 'admin' }),
    ]);
    await expect(
      svc.update('admin1', { status: 'disabled' }, actor),
    ).rejects.toMatchObject({
      message: 'cannot_modify_self',
    });
  });

  it('不能移除最后一个 active 管理员', async () => {
    const { svc } = makeService([user({ id: 'u1', role: 'admin' })]);
    await expect(svc.update('u1', { role: 'member' }, actor)).rejects.toMatchObject({
      message: 'last_admin',
    });
  });

  it('还有其他管理员时允许降级，并写 user.update 审计', async () => {
    const { svc, audits } = makeService([
      user({ id: 'u1', role: 'admin' }),
      user({ id: 'u2', email: 'u2@test.local', role: 'admin' }),
    ]);
    const out = await svc.update('u1', { role: 'member' }, actor);
    expect(out.role).toBe('member');
    expect(audits.at(-1)).toMatchObject({ action: 'user.update', targetId: 'u1' });
  });

  it('非法状态/角色抛 400', async () => {
    const { svc } = makeService([user()]);
    await expect(svc.update('u1', { status: 'deleted' }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('u1', { role: 'owner' }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('用户不存在抛 404', async () => {
    const { svc } = makeService([]);
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
