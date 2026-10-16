import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ArtifactService } from './artifacts.service';
import type { PrismaService } from '../db/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';
import type { ArtifactStorage } from './storage';
import type { ArtifactRef } from '@ai-office/shared';

const session = { id: 's1', tenantId: 't1', userId: 'u1' };

const rows: {
  id: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  kind: string;
  filename: string;
  storageKey: string;
  size: number;
  version: number;
  createdAt: Date;
}[] = [];

const fakePrisma = {
  artifact: {
    aggregate: async ({ where }: { where: { sessionId: string; filename: string } }) => {
      const versions = rows
        .filter((r) => r.sessionId === where.sessionId && r.filename === where.filename)
        .map((r) => r.version);
      return { _max: { version: versions.length ? Math.max(...versions) : null } };
    },
    create: async ({ data }: { data: typeof rows[number] }) => {
      const row = { id: `a${rows.length + 1}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    findMany: async ({ where }: { where: { sessionId: string; tenantId: string } }) =>
      rows
        .filter((r) => r.sessionId === where.sessionId && r.tenantId === where.tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
      rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
  },
} as unknown as PrismaService;

const fakeSessions = {
  assertOwned: async (sessionId: string, tenantId: string, userId: string) => {
    if (sessionId !== session.id || tenantId !== session.tenantId || userId !== session.userId) {
      throw new NotFoundException('session_not_found');
    }
  },
} as unknown as SessionsService;

const fakeStorage = {
  getObjectStream: async () => Readable.from([Buffer.from('bytes')]),
} as unknown as ArtifactStorage;

const ref: ArtifactRef = {
  kind: 'pptx',
  filename: '报告.pptx',
  storageKey: 'artifacts/t1/r1/x-报告.pptx',
  size: 12,
};

describe('ArtifactService', () => {
  let service: ArtifactService;

  beforeEach(() => {
    rows.length = 0;
    service = new ArtifactService(fakePrisma, fakeSessions, fakeStorage);
  });

  it('record 首次落库取 version=1', async () => {
    await service.record('r1', 's1', 't1', ref);
    expect(rows[0]).toMatchObject({ version: 1, filename: '报告.pptx', kind: 'pptx' });
  });

  it('同名重生成 version 递增', async () => {
    await service.record('r1', 's1', 't1', ref);
    await service.record('r2', 's1', 't1', {
      ...ref,
      storageKey: 'artifacts/t1/r2/x-报告.pptx',
    });
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it('record 拒绝非法 kind，不落库', async () => {
    await expect(
      service.record('r1', 's1', 't1', { ...ref, kind: 'exe' as ArtifactRef['kind'] }),
    ).rejects.toThrow('invalid_kind');
    expect(rows).toHaveLength(0);
  });

  it('record 拒绝越出租户前缀的 storageKey，不落库', async () => {
    await expect(
      service.record('r1', 's1', 't1', { ...ref, storageKey: 'artifacts/t2/r1/x' }),
    ).rejects.toThrow('invalid_storage_key');
    expect(rows).toHaveLength(0);
  });

  it('record 拒绝非法 size，不落库', async () => {
    await expect(service.record('r1', 's1', 't1', { ...ref, size: -1 })).rejects.toThrow(
      'invalid_size',
    );
    expect(rows).toHaveLength(0);
  });

  it('list 先校验会话归属，越权抛 404', async () => {
    await expect(service.list('s1', 't2', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list 返回本会话产物', async () => {
    await service.record('r1', 's1', 't1', ref);
    const out = await service.list('s1', 't1', 'u1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filename: '报告.pptx', size: 12, version: 1 });
  });

  it('getForDownload 越租户抛 404（不泄露存在性）', async () => {
    await service.record('r1', 's1', 't1', ref);
    await expect(service.getForDownload('a1', 't9', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getForDownload 返回文件名、类型与流', async () => {
    await service.record('r1', 's1', 't1', ref);
    const out = await service.getForDownload('a1', 't1', 'u1');
    expect(out.filename).toBe('报告.pptx');
    expect(out.kind).toBe('pptx');
    const chunks: Buffer[] = [];
    for await (const c of out.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('bytes');
  });

  it('getForDownload 同租户跨用户抛 404', async () => {
    await service.record('r1', 's1', 't1', ref);
    await expect(service.getForDownload('a1', 't1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
  });
});
