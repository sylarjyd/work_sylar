import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import type { PrismaService } from '../db/prisma.service';
import { SkillsService } from './skills.service';

type Row = {
  id: string;
  tenantId: string | null;
  ownerUserId: string | null;
  scope: string;
  name: string;
  description: string;
  content: string;
  source: string;
  sharedAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function matches(row: Row, where: Record<string, any>): boolean {
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.id && typeof where.id === 'string' && row.id !== where.id) return false;
  if (where.scope && row.scope !== where.scope) return false;
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where.ownerUserId !== undefined && row.ownerUserId !== where.ownerUserId) return false;
  if (where.enabled !== undefined && row.enabled !== where.enabled) return false;
  if (where.OR && !where.OR.some((part: Record<string, any>) => matches(row, part))) return false;
  return true;
}

function makeService(seed: Partial<Row>[] = []) {
  let seq = seed.length;
  const rows: Row[] = seed.map((item, index) => ({
    id: `s${index + 1}`,
    tenantId: 't1',
    ownerUserId: 'u1',
    scope: 'personal',
    name: `技能${index + 1}`,
    description: '',
    content: '正文',
    source: 'manual',
    sharedAt: null,
    enabled: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...item,
  }));
  const prisma = {
    skill: {
      findMany: async ({ where, orderBy }: any) => {
        const list = rows.filter((row) => matches(row, where ?? {}));
        if (orderBy?.updatedAt === 'desc') list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return list;
      },
      findFirst: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: any) => {
        seq += 1;
        const row: Row = {
          id: `s${seq}`,
          source: 'manual',
          sharedAt: null,
          enabled: true,
          description: '',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((item) => item.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: any) => {
        const index = rows.findIndex((item) => item.id === where.id);
        rows.splice(index, 1);
        return {};
      },
      findUnique: async ({ where }: any) => rows.find((item) => item.id === where.id) ?? null,
    },
  } as unknown as PrismaService;
  // 技能包相关：用内存对象存储替代 S3。
  const objects = new Map<string, Buffer>();
  const storage = {
    putObject: async (key: string, body: Buffer) => {
      objects.set(key, Buffer.from(body));
    },
    getObjectBuffer: async (key: string) => {
      const buffer = objects.get(key);
      if (!buffer) throw new Error('NoSuchKey');
      return buffer;
    },
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  };
  return {
    svc: new SkillsService(prisma, storage as never),
    rows,
    objects,
  };
}

describe('SkillsService', () => {
  it('列表只返回公共技能与自己的个人技能', async () => {
    const { svc } = makeService([
      { id: 'pub', scope: 'public', ownerUserId: null, tenantId: null },
      { id: 'mine' },
      { id: 'other', ownerUserId: 'u2' },
      { id: 'off', scope: 'public', ownerUserId: null, tenantId: null, enabled: false },
    ]);
    const out = await svc.list('t1', 'u1');
    expect(out.items.map((item) => item.id).sort()).toEqual(['mine', 'pub']);
    expect(out.items.find((item) => item.id === 'mine')?.owned).toBe(true);
  });

  it('创建的是个人技能，并做名称/正文校验', async () => {
    const { svc, rows } = makeService();
    const created = await svc.create('t1', 'u1', { name: '周报', content: '按模板写周报' });
    expect(created).toMatchObject({ scope: 'personal', owned: true, name: '周报' });
    expect(rows[0]).toMatchObject({ tenantId: 't1', ownerUserId: 'u1', scope: 'personal' });

    await expect(svc.create('t1', 'u1', { name: '', content: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('编辑/删除/共享只允许本人个人技能，他人或公共技能按 404', async () => {
    const { svc } = makeService([
      { id: 'other', ownerUserId: 'u2' },
      { id: 'pub', scope: 'public', ownerUserId: null, tenantId: null },
    ]);
    await expect(svc.update('other', 't1', 'u1', { name: 'x', content: 'y' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.remove('pub', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.share('pub', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('共享后变为公共，且本人不再能编辑', async () => {
    const { svc } = makeService([{ id: 'mine' }]);
    const shared = await svc.share('mine', 't1', 'u1');
    expect(shared.scope).toBe('public');
    expect(shared.sharedAt).not.toBeNull();
    await expect(svc.update('mine', 't1', 'u1', { name: 'x', content: 'y' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('运行期解析只保留启用的公共技能与本人个人技能，未知 id 丢弃', async () => {
    const { svc } = makeService([
      { id: 'pub', scope: 'public', ownerUserId: null, tenantId: null },
      { id: 'off', scope: 'public', ownerUserId: null, tenantId: null, enabled: false },
      { id: 'mine' },
      { id: 'other', ownerUserId: 'u2' },
    ]);
    const out = await svc.resolveForRun(['pub', 'off', 'mine', 'other', 'missing'], 't1', 'u1');
    expect(out.map((item) => item.id)).toEqual(['pub', 'mine']);
    expect(out[0]).toMatchObject({ name: '技能1', content: '正文' });
  });

  it('上传技能包：解析 SKILL.md、存 zip、可按路径读取包内文件', async () => {
    const { svc, objects } = makeService();
    const buffer = Buffer.from(
      zipSync({
        'SKILL.md': strToU8('---\nname: weekly-report\ndescription: 写周报\n---\n\n先列完成项'),
        'references/template.md': strToU8('模板内容'),
      }),
    );
    const created = await svc.createFromPackage('t1', 'u1', buffer);
    expect(created).toMatchObject({
      scope: 'personal',
      source: 'upload',
      slug: 'weekly-report',
      description: '写周报',
    });
    expect(created.files).toEqual([expect.objectContaining({ path: 'references/template.md' })]);
    expect(objects.size).toBe(1);

    const file = await svc.readPackageFile(
      created.id,
      { tenantId: 't1', userId: 'u1' },
      'references/template.md',
    );
    expect(file.buffer.toString('utf8')).toBe('模板内容');

    // 越权用户读不到包内文件。
    await expect(
      svc.readPackageFile(created.id, { tenantId: 't1', userId: 'u2' }, 'references/template.md'),
    ).rejects.toBeInstanceOf(NotFoundException);

    // 非 zip 直接拒绝，不落库。
    await expect(svc.createFromPackage('t1', 'u1', Buffer.from('bad'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
