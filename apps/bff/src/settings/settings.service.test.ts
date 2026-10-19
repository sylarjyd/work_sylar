import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

type Row = { key: string; value: unknown; updatedBy: string | null; updatedAt: Date };

function makeService() {
  const rows = new Map<string, Row>();
  const audits: unknown[] = [];
  const db = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null,
      upsert: async ({ where, create, update }: {
        where: { key: string };
        create: { key: string; value: unknown; updatedBy?: string };
        update: { value: unknown; updatedBy?: string };
      }) => {
        const row: Row = {
          key: where.key,
          value: 'value' in update ? update.value : create.value,
          updatedBy: 'updatedBy' in update ? (update.updatedBy ?? null) : (create.updatedBy ?? null),
          updatedAt: new Date('2026-10-19T00:00:00Z'),
        };
        rows.set(where.key, row);
        return row;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        const existed = rows.delete(where.key);
        return { count: existed ? 1 : 0 };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
        return {};
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  // 审计服务同样注入 mock db：$transaction 里传入的 tx 就是 db 本身。
  return { svc: new SettingsService(db, new AuditService(db)), rows, audits };
}

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

beforeEach(() => {
  process.env.CONFIRM_TIMEOUT_MS = '60000';
  delete process.env.CODE_EXEC_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.CONFIRM_TIMEOUT_MS;
});

describe('SettingsService', () => {
  it('无 DB 覆盖时按 env → 默认值解析来源', async () => {
    const { svc } = makeService();
    const all = await svc.getAll();
    const confirm = all.find((s) => s.key === 'confirmTimeoutMs')!;
    const exec = all.find((s) => s.key === 'codeExecTimeoutMs')!;
    expect(confirm).toMatchObject({ value: 60000, source: 'env' });
    expect(exec).toMatchObject({ value: 5000, source: 'default' });
  });

  it('DB 覆盖优先于 env', async () => {
    const { svc } = makeService();
    await svc.update('confirmTimeoutMs', 30000, actor);
    const item = (await svc.getAll()).find((s) => s.key === 'confirmTimeoutMs')!;
    expect(item).toMatchObject({ value: 30000, source: 'db' });
  });

  it('越界值抛 invalid_value', async () => {
    const { svc } = makeService();
    await expect(svc.update('maxRounds', 33, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('maxRounds', 1.5, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('kbChunkOverlap 必须小于生效的 kbChunkSize', async () => {
    const { svc } = makeService();
    await svc.update('kbChunkSize', 500, actor);
    await expect(svc.update('kbChunkOverlap', 500, actor)).rejects.toMatchObject({
      message: 'invalid_kbChunkOverlap',
    });
    await expect(svc.update('kbChunkOverlap', 200, actor)).resolves.toMatchObject({ value: 200 });
  });

  it('update 与审计同事务写入', async () => {
    const { svc, audits } = makeService();
    await svc.update('maxRounds', 12, actor);
    expect(audits[0]).toMatchObject({
      action: 'setting.update',
      targetType: 'setting',
      targetId: 'maxRounds',
      actorId: 'a1',
    });
  });

  it('reset 删除覆盖后回到 env/默认来源', async () => {
    const { svc } = makeService();
    await svc.update('confirmTimeoutMs', 30000, actor);
    const item = await svc.reset('confirmTimeoutMs', actor);
    expect(item).toMatchObject({ value: 60000, source: 'env' });
  });

  it('getRunConfig / getKbConfig 返回具体数值', async () => {
    const { svc } = makeService();
    await expect(svc.getRunConfig()).resolves.toEqual({
      maxRounds: 8,
      confirmTimeoutMs: 60000,
      codeExecTimeoutMs: 5000,
    });
    await expect(svc.getKbConfig()).resolves.toEqual({ chunkSize: 800, chunkOverlap: 150 });
  });
});
