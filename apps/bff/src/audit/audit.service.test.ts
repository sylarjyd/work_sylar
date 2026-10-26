import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { AuditService } from './audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from './audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local', ip: '127.0.0.1' };

function makeService(createImpl: (args: unknown) => Promise<unknown>) {
  const prisma = {
    adminAuditLog: {
      create: createImpl,
      findMany: async () => [
        {
          id: 'l1',
          actorId: 'a1',
          actorEmail: 'admin@test.local',
          action: 'user.update',
          targetType: 'user',
          targetId: 'u1',
          summary: { ok: true },
          ip: '127.0.0.1',
          createdAt: new Date('2026-10-19T00:00:00Z'),
        },
      ],
      count: async () => 1,
    },
  } as unknown as PrismaService;
  return new AuditService(prisma);
}

describe('AuditService', () => {
  it('write 把 actor 与 entry 落成一行', async () => {
    const created: unknown[] = [];
    const svc = makeService(async () => ({}));
    // write 要求传入事务客户端：用最小 mock 模拟 tx。
    const tx = {
      adminAuditLog: {
        create: async (args: unknown) => {
          created.push(args);
          return {};
        },
      },
    };
    await svc.write(tx as never, actor, {
      action: 'user.update',
      targetType: 'user',
      targetId: 'u1',
      summary: { before: 1 },
    });
    expect(created[0]).toMatchObject({
      data: {
        actorId: 'a1',
        actorEmail: 'admin@test.local',
        action: 'user.update',
        targetType: 'user',
        targetId: 'u1',
        summary: { before: 1 },
        ip: '127.0.0.1',
      },
    });
  });

  it('bestEffort 写失败不抛出', async () => {
    const svc = makeService(async () => {
      throw new Error('db down');
    });
    await expect(
      svc.bestEffort(actor, { action: 'user.view', targetType: 'user', targetId: 'u1' }),
    ).resolves.toBeUndefined();
  });

  it('record 与 bestEffort 不同：写失败必须上抛', async () => {
    const svc = makeService(async () => {
      throw new Error('db down');
    });
    // 必审操作不能静默丢审计，否则调用方无法感知“操作成功但没留痕”。
    await expect(
      svc.record(actor, { action: 'run.cancel', targetType: 'run', targetId: 'r1' }),
    ).rejects.toThrow('db down');
  });

  it('list 返回分页与 ISO 时间', async () => {
    const svc = makeService(async () => ({}));
    const page = await svc.list({ page: '1', pageSize: '20', action: 'user.update' });
    expect(page.total).toBe(1);
    expect(page.items[0].createdAt).toBe('2026-10-19T00:00:00.000Z');
  });
});
