import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminTenantsService } from './admin-tenants.service';
import type { AuditService } from '../audit/audit.service';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'admin1', email: 'admin@test.local' };
const summary = {
  plan: {
    id: 'pro', name: '专业版', priceCents: 9900, monthlyBaseCredits: 1000,
    monthlyBonusCredits: 0, maxCreditsPerRun: 100, rpm: 10, allowedModels: ['m'],
  },
  subscription: { status: 'active', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z' },
  balance: 900,
  reserved: 100,
  nextExpiry: null,
};

function makeService(exists = true) {
  const audits: unknown[] = [];
  const db = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        exists && where.id === 't1'
          ? {
              id: 't1', name: '团队', type: 'personal', createdAt: new Date('2026-01-01T00:00:00Z'),
              subscription: { planId: 'pro', status: 'active', plan: { name: '专业版' } },
              credit: { balance: 1000, reserved: 100 },
              _count: { users: 2 },
            }
          : null,
      findMany: async () => [{
        id: 't1', name: '团队', type: 'personal', createdAt: new Date('2026-01-01T00:00:00Z'),
        subscription: { planId: 'pro', status: 'active', plan: { name: '专业版' } },
        credit: { balance: 1000, reserved: 100 },
        _count: { users: 2 },
      }],
      count: async () => 1,
    },
    subscription: { findMany: async () => [{ tenantId: 't1' }] },
    session: { count: async () => 4 },
    adminAuditLog: { create: async () => ({}) },
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
  const billing = {
    adminSubscribe: vi.fn(async (_tenantId: string, _planId: string, _now: Date, hook?: (tx: unknown) => Promise<void>) => {
      await hook?.({});
      return summary;
    }),
    adjust: vi.fn(async (_tenantId: string, _amount: number, _note: string, _exp: Date | null, hook?: (tx: unknown) => Promise<void>) => {
      await hook?.({});
      return summary;
    }),
    summary: vi.fn(async () => summary),
  } as unknown as BillingService;
  return { svc: new AdminTenantsService(db, billing, audit), audits, billing };
}

describe('AdminTenantsService', () => {
  it('list 返回租户计费摘要', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0]).toMatchObject({
      id: 't1', planId: 'pro', balance: 900, reserved: 100, userCount: 2,
    });
  });

  it('detail 复用 BillingService.summary 并记 tenant.view', async () => {
    const { svc, audits, billing } = makeService();
    const detail = await svc.detail('t1', actor);
    expect(billing.summary).toHaveBeenCalledWith('t1');
    expect(detail).toMatchObject({ sessionCount: 4, billing: summary });
    expect(audits[0]).toMatchObject({ action: 'tenant.view', targetId: 't1' });
  });

  it('subscribe 作用于路径租户并在同一事务写审计', async () => {
    const { svc, audits, billing } = makeService();
    const out = await svc.subscribe('t1', { planId: 'pro' }, actor);
    expect(out).toEqual(summary);
    expect(billing.adminSubscribe).toHaveBeenCalledWith('t1', 'pro', expect.any(Date), expect.any(Function));
    expect(audits[0]).toMatchObject({ action: 'member.subscribe', targetId: 't1' });
  });

  it('credits 校验金额并写审计', async () => {
    const { svc, audits } = makeService();
    await svc.credits('t1', { amount: 100, note: '补偿' }, actor);
    expect(audits[0]).toMatchObject({ action: 'member.credits', targetId: 't1' });
    await expect(svc.credits('t1', { amount: 0 }, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.credits('t1', { amount: 1.5 }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('租户不存在抛 404', async () => {
    const { svc } = makeService(false);
    await expect(svc.detail('t1', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
