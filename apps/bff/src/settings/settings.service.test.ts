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

  it('kbChunkSize 必须大于当前生效的 kbChunkOverlap', async () => {
    const { svc } = makeService();
    await svc.update('kbChunkOverlap', 600, actor);
    await expect(svc.update('kbChunkSize', 500, actor)).rejects.toMatchObject({
      message: 'invalid_kbChunkSize',
    });
    await expect(svc.update('kbChunkSize', 601, actor)).resolves.toMatchObject({ value: 601 });
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

  it('空白 KB_CHUNK_OVERLAP env 视为未设置，回落默认 150 而非 0', async () => {
    const saved = process.env.KB_CHUNK_OVERLAP;
    process.env.KB_CHUNK_OVERLAP = '   ';
    try {
      const { svc } = makeService();
      const item = (await svc.getAll()).find((s) => s.key === 'kbChunkOverlap')!;
      expect(item).toMatchObject({ value: 150, source: 'default' });
      await expect(svc.getKbConfig()).resolves.toEqual({ chunkSize: 800, chunkOverlap: 150 });
    } finally {
      if (saved === undefined) delete process.env.KB_CHUNK_OVERLAP;
      else process.env.KB_CHUNK_OVERLAP = saved;
    }
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

  it('getQueueConfig 返回三个队列参数', async () => {
    const { svc } = makeService();
    await expect(svc.getQueueConfig()).resolves.toEqual({
      maxAttempts: 2,
      perTenantConcurrency: 2,
      maxPerTenant: 50,
    });
  });

  it('getQaCacheConfig 默认开启且有效期为 300 秒', async () => {
    const { svc } = makeService();
    await expect(svc.getQaCacheConfig()).resolves.toEqual({
      enabled: true,
      ttlSeconds: 300,
    });
  });

  it('问答缓存有效期只接受 10–86400 的整数', async () => {
    const { svc } = makeService();
    await expect(svc.update('qaCacheTtlSeconds', 9, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('qaCacheTtlSeconds', 86401, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('qaCacheTtlSeconds', 600, actor)).resolves.toMatchObject({
      value: 600,
    });
    await svc.update('qaCacheEnabled', false, actor);
    await expect(svc.getQaCacheConfig()).resolves.toEqual({ enabled: false, ttlSeconds: 600 });
  });

  it('按类型解析布尔、字符串与 secret，且不泄露明文', async () => {
    const { svc } = makeService();
    process.env.ALERTS_ENABLED = 'false';
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/alert';
    process.env.ALERT_WEBHOOK_SECRET = 'secret-token-9876';
    try {
      const all = await svc.getAll();
      const enabled = all.find((s) => s.key === 'alertsEnabled')!;
      const url = all.find((s) => s.key === 'alertWebhookUrl')!;
      const secret = all.find((s) => s.key === 'alertWebhookSecret')!;
      expect(enabled).toMatchObject({ type: 'boolean', value: false, source: 'env' });
      expect(url).toMatchObject({
        type: 'string',
        value: 'https://hooks.example.com/alert',
        source: 'env',
      });
      expect(secret).toMatchObject({
        type: 'secret',
        configured: true,
        maskedValue: '****9876',
        source: 'env',
      });
      expect(JSON.stringify(secret)).not.toContain('secret-token-9876');
    } finally {
      delete process.env.ALERTS_ENABLED;
      delete process.env.ALERT_WEBHOOK_URL;
      delete process.env.ALERT_WEBHOOK_SECRET;
    }
  });

  it('secret 更新与审计都只出现脱敏值', async () => {
    const { svc, audits } = makeService();
    const saved = await svc.update('alertWebhookSecret', 'secret-token-9876', actor);
    expect(saved).toMatchObject({
      type: 'secret',
      configured: true,
      maskedValue: '****9876',
      source: 'db',
    });
    expect(JSON.stringify(saved)).not.toContain('secret-token-9876');
    expect(JSON.stringify(audits)).not.toContain('secret-token-9876');

    const cleared = await svc.update('alertWebhookSecret', null, actor);
    expect(cleared).toMatchObject({
      type: 'secret',
      configured: false,
      maskedValue: null,
      source: 'db',
    });
  });

  it('显式清空 secret 不会被 env 复活', async () => {
    const { svc } = makeService();
    process.env.ALERT_WEBHOOK_SECRET = 'env-secret-1234';
    try {
      await svc.update('alertWebhookSecret', null, actor);
      const item = (await svc.getAll()).find((s) => s.key === 'alertWebhookSecret')!;
      expect(item).toMatchObject({ configured: false, source: 'db' });
      expect(JSON.stringify(item)).not.toContain('env-secret-1234');
    } finally {
      delete process.env.ALERT_WEBHOOK_SECRET;
    }
  });

  it('alertWebhookUrl 仅接受 http/https', async () => {
    const { svc } = makeService();
    await expect(svc.update('alertWebhookUrl', 'ftp://example.com', actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('alertWebhookUrl', 'not-a-url', actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('alertWebhookUrl', 'https://example.com/hook', actor)).resolves.toMatchObject(
      { value: 'https://example.com/hook' },
    );
  });

  it('记忆配置默认全部开启：24000 字符预算、召回 5 条', async () => {
    const { svc } = makeService();
    await expect(svc.getMemoryConfig()).resolves.toEqual({
      enabled: true,
      historyMaxChars: 24000,
      longTermTopK: 5,
    });
  });

  it('记忆配置读取 DB 覆盖值', async () => {
    const { svc } = makeService();
    await svc.update('memoryEnabled', false, actor);
    await svc.update('memoryHistoryMaxChars', 8000, actor);
    await svc.update('memoryLongTermTopK', 0, actor);
    await expect(svc.getMemoryConfig()).resolves.toEqual({
      enabled: false,
      historyMaxChars: 8000,
      longTermTopK: 0,
    });
  });

  it('记忆参数越界抛 invalid_value', async () => {
    const { svc } = makeService();
    await expect(svc.update('memoryHistoryMaxChars', 1999, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('memoryLongTermTopK', 11, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('memoryEnabled', 'true', actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getAlertSettings 返回生效配置', async () => {
    const { svc } = makeService();
    await svc.update('alertsEnabled', false, actor);
    await svc.update('alertWebhookUrl', 'https://example.com/hook', actor);
    await svc.update('alertWebhookSecret', 'secret-token-9876', actor);
    await expect(svc.getAlertSettings()).resolves.toEqual({
      enabled: false,
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-token-9876',
    });
  });
});
