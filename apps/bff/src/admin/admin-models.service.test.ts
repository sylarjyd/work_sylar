import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminModelsService, listProviders } from './admin-models.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

function makeService(inUse = false) {
  const prices = new Map([
    ['m1', { model: 'm1', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 200, updatedAt: new Date('2026-10-01T00:00:00Z') }],
  ]);
  const audits: unknown[] = [];
  const db = {
    modelPrice: {
      findMany: async () => [...prices.values()],
      findUnique: async ({ where }: { where: { model: string } }) => prices.get(where.model) ?? null,
      create: async ({ data }: { data: { model: string; inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number } }) => {
        // 模拟唯一键冲突。
        if (prices.has(data.model)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { ...data, updatedAt: new Date('2026-10-19T00:00:00Z') };
        prices.set(data.model, row);
        return row;
      },
      update: async ({ where, data }: { where: { model: string }; data: Record<string, number> }) => {
        const prev = prices.get(where.model);
        // 模拟行不存在。
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        const row = { ...prev, ...data, updatedAt: new Date('2026-10-19T00:00:00Z') };
        prices.set(where.model, row);
        return row;
      },
      delete: async ({ where }: { where: { model: string } }) => {
        const prev = prices.get(where.model);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        prices.delete(where.model);
        return prev;
      },
    },
    plan: {
      findFirst: async () => (inUse ? { id: 'pro' } : null),
    },
    // 模拟 SELECT ... FOR UPDATE：价格行存在时返回它，否则返回空集。
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const model = values[0] as string;
      return prices.has(model) ? [{ model }] : [];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminModelsService(db, audit), audits };
}

describe('AdminModelsService', () => {
  it('catalog 不返回任何密钥信息', () => {
    const providers = listProviders({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'http://x', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'http://x', apiKeyEnv: 'KEY_A' },
      ]),
    });
    expect(providers).toEqual([{ name: 'KEY_A', models: ['a', 'b'] }]);
    expect(JSON.stringify(providers)).not.toContain('http://x');
  });

  it('创建/更新/删除写审计', async () => {
    const { svc, audits } = makeService();
    await svc.create({ model: 'm2', inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 2 }, actor);
    await svc.update('m2', { inputMilliCreditsPer1k: 3 }, actor);
    await svc.remove('m2', actor);
    expect(audits.map((a) => (a as { action: string }).action)).toEqual([
      'modelPrice.create',
      'modelPrice.update',
      'modelPrice.delete',
    ]);
  });

  it('重复模型抛 409', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ model: 'm1', inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('负价格抛 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ model: 'm2', inputMilliCreditsPer1k: -1, outputMilliCreditsPer1k: 1 }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('超出 Int32 上限抛 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ model: 'm2', inputMilliCreditsPer1k: 2_147_483_648, outputMilliCreditsPer1k: 1 }, actor),
    ).rejects.toMatchObject({ message: 'invalid_price' });
  });

  it('更新路径模型名会归一化', async () => {
    const { svc } = makeService();
    const row = await svc.update(' m1 ', { inputMilliCreditsPer1k: 1 }, actor);
    expect(row.model).toBe('m1');
    expect(row.inputMilliCreditsPer1k).toBe(1);
  });

  it('被启用套餐引用时拒绝删除', async () => {
    const { svc } = makeService(true);
    await expect(svc.remove('m1', actor)).rejects.toMatchObject({ message: 'model_in_use' });
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(
      svc.update('missing', { inputMilliCreditsPer1k: 1 }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    // 存在性优先于请求体校验，避免用 400/404 差异探测模型是否存在。
    await expect(svc.update('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
