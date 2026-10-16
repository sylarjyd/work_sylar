import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConnectorService, ValidateFailedError } from './connector.service';
import type { PrismaService } from '../db/prisma.service';
import { encrypt, decrypt } from './crypto';

let rows: Record<string, unknown>[];
let runtimeCalls: Record<string, unknown>[];
let runtimeOk = true;
let runtimeTools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: 'echo', description: '回显', inputSchema: { type: 'object' } },
];

const fakePrisma = {
  connector: {
    findFirst: async ({ where }: { where: { tenantId: string; name?: string; id?: string } }) =>
      rows.find((r) => r.tenantId === where.tenantId && (where.name ? r.name === where.name : r.id === where.id)) ?? null,
    findMany: async ({ where }: { where: { tenantId: string; enabled?: boolean } }) =>
      rows.filter((r) => r.tenantId === where.tenantId && (where.enabled === undefined || r.enabled === where.enabled)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `c${rows.length + 1}`,
        toolCount: 0,
        lastValidatedAt: null,
        enabled: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...data,
      };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      rows = rows.filter((r) => r.id !== where.id);
      return {};
    },
  },
} as unknown as PrismaService;

function makeService() {
  return new ConnectorService(fakePrisma, {
    runtimeUrl: 'http://runtime',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      runtimeCalls.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify(runtimeOk ? { ok: true, tools: runtimeTools } : { ok: false, error: 'spawn_failed' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch,
  });
}

beforeEach(() => {
  process.env.CONNECTOR_ENC_KEY = 'a'.repeat(64);
  rows = [];
  runtimeCalls = [];
  runtimeOk = true;
  runtimeTools = [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }];
});

describe('ConnectorService.create', () => {
  it('校验通过才落库：env 加密存储、记录 toolCount 与校验时间', async () => {
    const dto = await makeService().create(
      { name: 'echo', command: 'node', args: ['s.mjs'], env: { API_KEY: 'sk-1' } },
      't1',
      'u1',
    );
    expect(runtimeCalls[0]).toMatchObject({ command: 'node', args: ['s.mjs'], env: { API_KEY: 'sk-1' } });
    expect(dto).toMatchObject({ name: 'echo', command: 'node', args: ['s.mjs'], enabled: true, toolCount: 1 });
    expect((dto as { env?: unknown }).env).toBeUndefined();
    const stored = rows[0].envEncrypted as string;
    expect(stored).not.toContain('sk-1');
    expect(JSON.parse(decrypt(stored))).toEqual({ API_KEY: 'sk-1' });
  });

  it('重名抛 Conflict duplicate_name，不校验不落库', async () => {
    rows.push({ id: 'c1', tenantId: 't1', name: 'echo', enabled: true });
    await expect(makeService().create({ name: 'echo', command: 'node' }, 't1', 'u1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(runtimeCalls).toHaveLength(0);
  });

  it('runtime 校验失败抛 ValidateFailedError，不落库', async () => {
    runtimeOk = false;
    await expect(makeService().create({ name: 'bad', command: 'nope' }, 't1', 'u1')).rejects.toBeInstanceOf(
      ValidateFailedError,
    );
    expect(rows).toHaveLength(0);
  });

  it('runtime 校验失败不泄漏原始错误，message 为固定码', async () => {
    runtimeOk = false;
    const err = await makeService()
      .create({ name: 'bad', command: 'nope' }, 't1', 'u1')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidateFailedError);
    expect(err.message).toBe('validate_failed');
  });
});

describe('ConnectorService.list / remove / listEnabled', () => {
  it('list 仅返回本租户，且 DTO 不含 env', async () => {
    rows.push({ id: 'c1', tenantId: 't1', name: 'a', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 2, lastValidatedAt: new Date('2026-01-02T00:00:00Z'), createdAt: new Date('2026-01-01T00:00:00Z') });
    rows.push({ id: 'c9', tenantId: 't9', name: 'x', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    const out = await makeService().list('t1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'a', toolCount: 2 });
    expect((out[0] as { env?: unknown }).env).toBeUndefined();
  });

  it('remove 跨租户抛 NotFound 且行仍在', async () => {
    rows.push({ id: 'cX', tenantId: 't9', name: 'x', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    await expect(makeService().remove('cX', 't1')).rejects.toBeInstanceOf(NotFoundException);
    expect(rows.some((r) => r.id === 'cX')).toBe(true);
  });

  it('listEnabled 返回解密 env 的启用连接器', async () => {
    rows.push({ id: 'c1', tenantId: 't1', name: 'a', command: 'node', args: ['x'], envEncrypted: encrypt(JSON.stringify({ K: 'v' })), enabled: true });
    rows.push({ id: 'c2', tenantId: 't1', name: 'b', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: false });
    const out = await makeService().listEnabled('t1');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 'c1', name: 'a', command: 'node', args: ['x'], env: { K: 'v' }, enabled: true });
  });
});

describe('ConnectorService.update', () => {
  it('改 command/args/env 时重新校验并刷新 toolCount', async () => {
    rows.push({ id: 'c1', tenantId: 't1', name: 'a', command: 'old', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    runtimeTools = [{ name: 't1', description: '', inputSchema: {} }, { name: 't2', description: '', inputSchema: {} }];
    const dto = await makeService().update('c1', 't1', { command: 'new' });
    expect(runtimeCalls).toHaveLength(1);
    expect(dto).toMatchObject({ command: 'new', toolCount: 2 });
  });

  it('仅切 enabled 不触发校验', async () => {
    rows.push({ id: 'c1', tenantId: 't1', name: 'a', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    const dto = await makeService().update('c1', 't1', { enabled: false });
    expect(runtimeCalls).toHaveLength(0);
    expect(dto).toMatchObject({ enabled: false });
  });

  it('改名撞重名抛 Conflict，不触发校验且原名不变', async () => {
    rows.push({ id: 'c1', tenantId: 't1', name: 'a', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    rows.push({ id: 'c2', tenantId: 't1', name: 'b', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    await expect(makeService().update('c1', 't1', { name: 'b' })).rejects.toBeInstanceOf(ConflictException);
    expect(runtimeCalls).toHaveLength(0);
    expect(rows.find((r) => r.id === 'c1')!.name).toBe('a');
  });

  it('跨租户 update 抛 NotFound 且行仍在', async () => {
    rows.push({ id: 'cX', tenantId: 't9', name: 'x', command: 'node', args: [], envEncrypted: encrypt('{}'), enabled: true, toolCount: 0, lastValidatedAt: null, createdAt: new Date() });
    await expect(makeService().update('cX', 't1', { enabled: false })).rejects.toBeInstanceOf(NotFoundException);
    expect(rows.some((r) => r.id === 'cX')).toBe(true);
  });
});
