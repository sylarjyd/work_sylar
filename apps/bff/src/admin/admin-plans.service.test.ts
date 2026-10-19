import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminPlansService } from './admin-plans.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

type PlanRow = {
  id: string; name: string; priceCents: number; monthlyBaseCredits: number;
  monthlyBonusCredits: number; maxCreditsPerRun: number; rpm: number;
  allowedModels: string[]; active: boolean; createdAt: Date;
};

function makeService(prices = ['m1']) {
  const plans = new Map<string, PlanRow>();
  plans.set('free', {
    id: 'free', name: '免费版', priceCents: 0, monthlyBaseCredits: 100,
    monthlyBonusCredits: 0, maxCreditsPerRun: 10, rpm: 2,
    allowedModels: ['m1'], active: true, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const audits: unknown[] = [];
  const db = {
    plan: {
      findMany: async () => [...plans.values()],
      findUnique: async ({ where }: { where: { id: string } }) => plans.get(where.id) ?? null,
      create: async ({ data }: { data: PlanRow }) => {
        plans.set(data.id, data);
        return data;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<PlanRow> }) => {
        const next = { ...plans.get(where.id)!, ...data };
        plans.set(where.id, next);
        return next;
      },
    },
    modelPrice: {
      findMany: async ({ where }: { where: { model: { in: string[] } } }) =>
        where.model.in.filter((m) => prices.includes(m)).map((model) => ({ model })),
    },
    adminAuditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminPlansService(db, audit), plans, audits };
}

describe('AdminPlansService', () => {
  it('listAll 返回含停用套餐', async () => {
    const { svc } = makeService();
    await expect(svc.listAll()).resolves.toHaveLength(1);
  });

  it('创建校验 slug 与数值', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ id: 'Bad ID', name: 'x', priceCents: 0, monthlyBaseCredits: 0, monthlyBonusCredits: 0, maxCreditsPerRun: 0, rpm: 0, allowedModels: ['m1'], active: true }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allowedModels 必须都有价格', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ id: 'pro', name: '专业版', priceCents: 1, monthlyBaseCredits: 1, monthlyBonusCredits: 0, maxCreditsPerRun: 1, rpm: 1, allowedModels: ['missing'], active: true }, actor),
    ).rejects.toMatchObject({ message: 'model_price_missing' });
  });

  it('重复 id 抛 409', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ id: 'free', name: 'x', priceCents: 0, monthlyBaseCredits: 0, monthlyBonusCredits: 0, maxCreditsPerRun: 0, rpm: 0, allowedModels: ['m1'], active: true }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('free 不可停用', async () => {
    const { svc } = makeService();
    await expect(svc.update('free', { active: false }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('更新写 plan.update 审计', async () => {
    const { svc, audits } = makeService();
    const out = await svc.update('free', { name: '基础版' }, actor);
    expect(out.name).toBe('基础版');
    expect(audits[0]).toMatchObject({ action: 'plan.update', targetId: 'free' });
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.update('nope', { name: 'x' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
