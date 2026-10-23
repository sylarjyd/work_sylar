import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { ModelUnavailableError } from '../models/model.errors';
import type { ModelCatalogService } from '../models/model-catalog.service';
import type { PrismaService } from '../db/prisma.service';

const all = [
  { id: 's1', tenantId: 't1', userId: 'u1', title: 'active', status: 'active', model: 'm1', createdAt: new Date() },
  { id: 's2', tenantId: 't1', userId: 'u1', title: 'archived', status: 'archived', model: null, createdAt: new Date() },
];

function makeService(models = ['m1', 'm2'], defaultModel: string | null = 'm1') {
  const created: { model?: string }[] = [];
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
      create: async ({ data }: { data: { tenantId: string; userId: string; title: string; model?: string } }) => {
        created.push({ model: data.model });
        return { id: 's3', createdAt: new Date(), ...data };
      },
    },
  } as unknown as PrismaService;
  const catalog = {
    available: async () => ({
      models: models.map((model) => ({
        model,
        displayName: model,
        providerName: 'p',
        sortOrder: 0,
        source: { kind: 'mock' as const },
      })),
      defaultModel,
    }),
  } as unknown as ModelCatalogService;
  return { svc: new SessionsService(prisma, catalog), created };
}

describe('SessionsService 归档语义', () => {
  it('list 不返回归档会话，并带出会话模型', async () => {
    const list = await makeService().svc.list('t1', 'u1');
    expect(list.map((s) => s.id)).toEqual(['s1']);
    expect(list[0].model).toBe('m1');
  });

  it('归档会话对普通用户视为不存在', async () => {
    await expect(makeService().svc.assertOwned('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SessionsService 选模', () => {
  it('未指定模型时使用默认模型并落库', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', {});
    expect(s.model).toBe('m1');
    expect(created).toEqual([{ model: 'm1' }]);
  });

  it('指定模型必须在可用列表内', async () => {
    const { svc, created } = makeService();
    await expect(svc.create('t1', 'u1', { model: 'gone' })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(created).toEqual([]);
  });

  it('指定可用模型时原样落库', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { model: 'm2' });
    expect(s.model).toBe('m2');
    expect(created).toEqual([{ model: 'm2' }]);
  });

  it('assertOwned 返回会话模型供运行时解析', async () => {
    const ref = await makeService().svc.assertOwned('s1', 't1', 'u1');
    expect(ref).toEqual({ id: 's1', model: 'm1' });
  });
});
