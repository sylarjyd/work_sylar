import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminKbService } from './admin-kb.service';
import type { PrismaService } from '../db/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import type { KbStorage } from '../kb/storage';

const actor: AdminActor = { id: 'admin1', email: 'admin@test.local', ip: '127.0.0.1' };

interface BaseFixture {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DocFixture {
  id: string;
  knowledgeBaseId: string;
  tenantId: string;
  userId: string;
  filename: string;
  mime: string;
  size: number;
  status: string;
  chunkCount: number;
  error: string | null;
  storageKey: string;
  createdAt: Date;
}

const bases: BaseFixture[] = [
  {
    id: 'b1',
    tenantId: 't1',
    userId: 'u1',
    name: '项目资料',
    description: '研发文档',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-03T00:00:00Z'),
  },
  {
    id: 'b2',
    tenantId: 't2',
    userId: 'u2',
    name: '合同库',
    description: '',
    createdAt: new Date('2026-10-02T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  },
  {
    id: 'b3',
    tenantId: 't2',
    userId: 'u3',
    name: '项目资料二',
    description: '',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  },
];

const docs: DocFixture[] = [
  {
    id: 'd1',
    knowledgeBaseId: 'b1',
    tenantId: 't1',
    userId: 'u1',
    filename: '设计.md',
    mime: 'text/markdown',
    size: 100,
    status: 'ready',
    chunkCount: 3,
    error: null,
    storageKey: 'kb/t1/u1/b1/x1/设计.md',
    createdAt: new Date('2026-10-03T00:00:00Z'),
  },
  {
    id: 'd2',
    knowledgeBaseId: 'b1',
    tenantId: 't1',
    userId: 'u1',
    filename: '需求.pdf',
    mime: 'application/pdf',
    size: 50,
    status: 'pending',
    chunkCount: 0,
    error: null,
    storageKey: 'kb/t1/u1/b1/x2/需求.pdf',
    createdAt: new Date('2026-10-02T00:00:00Z'),
  },
  {
    id: 'd3',
    knowledgeBaseId: 'b2',
    tenantId: 't2',
    userId: 'u2',
    filename: '合同.txt',
    mime: 'text/plain',
    size: 20,
    status: 'failed',
    chunkCount: 0,
    error: 'parse_failed',
    storageKey: 'kb/t2/u2/b2/x3/合同.txt',
    createdAt: new Date('2026-10-02T00:00:00Z'),
  },
];

const users = [
  { id: 'u1', tenantId: 't1', email: 'alice@test.local' },
  { id: 'u2', tenantId: 't2', email: 'bob@test.local' },
  { id: 'u3', tenantId: 't2', email: 'carol@test.local' },
];

const tenants = [
  { id: 't1', name: '甲公司' },
  { id: 't2', name: '乙公司' },
];

function matchesBase(base: BaseFixture, where: any): boolean {
  if (where?.tenantId && base.tenantId !== where.tenantId) return false;
  const or = where?.OR as any[] | undefined;
  if (!or) return true;
  return or.some((clause) => {
    if (clause.name?.contains) {
      return base.name.toLowerCase().includes(String(clause.name.contains).toLowerCase());
    }
    if (clause.userId?.in) return clause.userId.in.includes(base.userId);
    return false;
  });
}

function groupDocs(rows: DocFixture[], args: any) {
  const by: string[] = args.by;
  const map = new Map<string, { key: Record<string, string>; rows: DocFixture[] }>();
  for (const row of rows) {
    const key = Object.fromEntries(by.map((field) => [field, (row as any)[field]]));
    const id = JSON.stringify(key);
    const entry = map.get(id) ?? { key, rows: [] };
    entry.rows.push(row);
    map.set(id, entry);
  }
  return [...map.values()].map(({ key, rows: group }) => ({
    ...key,
    _count: { _all: group.length },
    _sum: {
      chunkCount: group.reduce((sum, d) => sum + d.chunkCount, 0),
      size: group.reduce((sum, d) => sum + d.size, 0),
    },
  }));
}

function makeService(options: { failCleanup?: boolean } = {}) {
  const liveBases = bases.map((b) => ({ ...b }));
  const liveDocs = docs.map((d) => ({ ...d }));
  const execCalls: string[] = [];
  const auditWrites: Array<Record<string, unknown>> = [];
  const auditBestEffort: Array<Record<string, unknown>> = [];
  const deletedObjects: string[] = [];

  const prisma: any = {
    knowledgeBase: {
      count: async ({ where }: any = {}) =>
        liveBases.filter((b) => (where ? matchesBase(b, where) : true)).length,
      findMany: async ({ where, skip = 0, take = liveBases.length }: any = {}) =>
        liveBases
          .filter((b) => (where ? matchesBase(b, where) : true))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
          .slice(skip, skip + take)
          .map((b) => ({ ...b })),
      findUnique: async ({ where }: any) => {
        const base = liveBases.find((b) => b.id === where.id);
        return base ? { ...base } : null;
      },
      groupBy: async ({ by }: any) => {
        const seen = new Map<string, number>();
        for (const base of liveBases) {
          const key = JSON.stringify(by.map((field: string) => (base as any)[field]));
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        return [...seen.entries()].map(([key, count]) => ({
          ...JSON.parse(key).reduce(
            (acc: Record<string, unknown>, value: unknown, i: number) => {
              acc[by[i]] = value;
              return acc;
            },
            {},
          ),
          _count: { _all: count },
        }));
      },
      delete: async ({ where }: any) => {
        const i = liveBases.findIndex((b) => b.id === where.id);
        if (i < 0) throw { code: 'P2025' };
        const [removed] = liveBases.splice(i, 1);
        // 模拟外键级联：文档随库删除。
        for (let j = liveDocs.length - 1; j >= 0; j--) {
          if (liveDocs[j].knowledgeBaseId === removed.id) liveDocs.splice(j, 1);
        }
        return removed;
      },
    },
    kbDoc: {
      groupBy: async ({ where, by }: any) => {
        const rows = liveDocs.filter((d) =>
          where?.knowledgeBaseId?.in
            ? where.knowledgeBaseId.in.includes(d.knowledgeBaseId)
            : true,
        );
        return groupDocs(rows, { by });
      },
      findMany: async ({ where, skip = 0, take = liveDocs.length }: any = {}) =>
        liveDocs
          .filter((d) => (where?.knowledgeBaseId ? d.knowledgeBaseId === where.knowledgeBaseId : true))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(skip, skip + take)
          .map((d) => ({ ...d })),
      count: async ({ where }: any) =>
        liveDocs.filter((d) => !where?.knowledgeBaseId || d.knowledgeBaseId === where.knowledgeBaseId)
          .length,
      findFirst: async ({ where }: any) =>
        liveDocs.find(
          (d) =>
            d.id === where.id &&
            (!where.knowledgeBaseId || d.knowledgeBaseId === where.knowledgeBaseId),
        ) ?? null,
      delete: async ({ where }: any) => {
        const i = liveDocs.findIndex((d) => d.id === where.id);
        if (i < 0) throw { code: 'P2025' };
        return liveDocs.splice(i, 1)[0];
      },
    },
    user: {
      findMany: async ({ where }: any) =>
        users.filter((u) => {
          if (where?.tenantId && u.tenantId !== where.tenantId) return false;
          const contains = where?.email?.contains ?? where?.id?.in;
          if (where?.email?.contains) {
            return u.email.toLowerCase().includes(String(where.email.contains).toLowerCase());
          }
          if (where?.id?.in) return where.id.in.includes(u.id);
          return Boolean(contains);
        }),
    },
    tenant: {
      findMany: async ({ where }: any) => tenants.filter((t) => where?.id?.in?.includes(t.id)),
    },
  };
  prisma.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execCalls.push(strings.join('?'));
    return values.length;
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: Record<string, unknown>) => {
      auditWrites.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: Record<string, unknown>) => {
      auditBestEffort.push(entry);
    },
  } as unknown as AuditService;

  const storage = {
    putObject: async () => undefined,
    deleteObject: async () => undefined,
    deleteObjects: async (keys: string[]) => {
      if (options.failCleanup) throw new Error('s3 down');
      deletedObjects.push(...keys);
      return [];
    },
  } as unknown as KbStorage;

  return {
    svc: new AdminKbService(prisma as unknown as PrismaService, audit, storage),
    execCalls,
    auditWrites,
    auditBestEffort,
    deletedObjects,
    liveBases,
    liveDocs,
  };
}

describe('AdminKbService 列表与统计', () => {
  it('列表补所有者/租户信息与文档统计，按更新时间倒序', async () => {
    const { svc } = makeService();
    const page = await svc.list({});
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expect(page.items.map((i) => i.id)).toEqual(['b1', 'b2', 'b3']);
    expect(page.items[0]).toMatchObject({
      name: '项目资料',
      tenantId: 't1',
      tenantName: '甲公司',
      userId: 'u1',
      userEmail: 'alice@test.local',
      docCount: 2,
      readyCount: 1,
      pendingCount: 1,
      failedCount: 0,
      chunkCount: 3,
      totalBytes: 150,
    });
    // 内部字段 storageKey 绝不进入 DTO。
    expect(JSON.stringify(page)).not.toContain('storageKey');
  });

  it('q 同时匹配库名与所有者邮箱，并支持租户过滤', async () => {
    const { svc } = makeService();
    const byName = await svc.list({ q: '项目' });
    expect(byName.items.map((i) => i.id)).toEqual(['b1', 'b3']);

    const byEmail = await svc.list({ q: 'bob@test.local' });
    expect(byEmail.items.map((i) => i.id)).toEqual(['b2']);

    const byTenant = await svc.list({ tenantId: 't2' });
    expect(byTenant.items.map((i) => i.id)).toEqual(['b2', 'b3']);
  });

  it('服务端分页', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: 2, pageSize: 1 });
    expect(page).toMatchObject({ total: 3, page: 2, pageSize: 1 });
    expect(page.items.map((i) => i.id)).toEqual(['b2']);
  });

  it('统计汇总库/文档/状态/切片/租户数', async () => {
    const { svc } = makeService();
    await expect(svc.stats()).resolves.toEqual({
      baseCount: 3,
      docCount: 3,
      readyCount: 1,
      pendingCount: 1,
      failedCount: 1,
      chunkCount: 3,
      totalBytes: 170,
      tenantCount: 2,
    });
  });

  it('详情返回文档分页，不存在的库 404', async () => {
    const { svc } = makeService();
    const detail = await svc.detail('b1', { docPage: 1, docPageSize: 1 });
    expect(detail).toMatchObject({ id: 'b1', name: '项目资料', docCount: 2 });
    expect(detail.docs).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(detail.docs.items.map((d) => d.id)).toEqual(['d1']);

    await expect(svc.detail('missing', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminKbService 删除', () => {
  it('删库要求库名精确匹配，不匹配不执行删除', async () => {
    const { svc, liveBases } = makeService();
    await expect(
      svc.deleteBase('b1', { confirmName: '项目' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(liveBases).toHaveLength(3);
    await expect(svc.deleteBase('missing', { confirmName: 'x' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('删库在事务内解绑助手绑定、写审计并在提交后清理对象', async () => {
    const { svc, execCalls, auditWrites, deletedObjects, liveDocs } = makeService();
    const result = await svc.deleteBase('b1', { confirmName: '项目资料' }, actor);
    expect(result).toEqual({ deletedDocs: 2, cleanupFailed: 0 });
    expect(execCalls[0]).toContain('array_remove');
    expect(auditWrites[0]).toMatchObject({
      action: 'kb.base.delete',
      targetType: 'kb_base',
      targetId: 'b1',
      summary: { name: '项目资料', tenantId: 't1', userId: 'u1', deletedDocs: 2 },
    });
    expect(deletedObjects).toEqual([
      'kb/t1/u1/b1/x1/设计.md',
      'kb/t1/u1/b1/x2/需求.pdf',
    ]);
    expect(liveDocs.map((d) => d.id)).toEqual(['d3']);
  });

  it('对象存储清理失败不改写删除结果，但记审计', async () => {
    const { svc, auditBestEffort } = makeService({ failCleanup: true });
    const result = await svc.deleteBase('b1', { confirmName: '项目资料' }, actor);
    expect(result).toEqual({ deletedDocs: 2, cleanupFailed: 2 });
    expect(auditBestEffort[0]).toMatchObject({
      action: 'kb.storage_cleanup_failed',
      targetType: 'kb_base',
      targetId: 'b1',
      summary: { failed: 2 },
    });
  });

  it('删文档要求 ID 确认并校验归属', async () => {
    const { svc } = makeService();
    await expect(
      svc.deleteDoc('b1', 'd1', { confirmId: 'd2' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    // 文档不属于该库同样视为不存在，避免跨库删除。
    await expect(
      svc.deleteDoc('b1', 'd3', { confirmId: 'd3' }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.deleteDoc('missing', 'd1', { confirmId: 'd1' }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('删文档写审计并在提交后清理对象', async () => {
    const { svc, auditWrites, deletedObjects, liveDocs } = makeService();
    const result = await svc.deleteDoc('b1', 'd1', { confirmId: 'd1' }, actor);
    expect(result).toEqual({ deletedDocs: 1, cleanupFailed: 0 });
    expect(auditWrites[0]).toMatchObject({
      action: 'kb.doc.delete',
      targetType: 'kb_doc',
      targetId: 'd1',
      summary: { baseId: 'b1', filename: '设计.md' },
    });
    expect(deletedObjects).toEqual(['kb/t1/u1/b1/x1/设计.md']);
    expect(liveDocs.map((d) => d.id)).toEqual(['d2', 'd3']);
  });
});
