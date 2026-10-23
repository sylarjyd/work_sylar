import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../db/prisma.service';
import { AssistantsService } from './assistants.service';

interface Row {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: string;
  model: string | null;
  skills: string[];
  kbDocIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

function makeService() {
  const rows: Row[] = [];
  const docs = [
    { id: 'd1', tenantId: 't1', userId: 'u1' },
    { id: 'd2', tenantId: 't1', userId: 'u1' },
    { id: 'dx', tenantId: 't2', userId: 'u2' },
  ];
  let seq = 0;
  const prisma = {
    assistant: {
      findMany: async ({ where }: { where: { tenantId: string; userId: string } }) =>
        rows.filter((r) => r.tenantId === where.tenantId && r.userId === where.userId),
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string; userId: string };
      }) =>
        rows.find(
          (r) =>
            r.id === where.id && r.tenantId === where.tenantId && r.userId === where.userId,
        ) ?? null,
      create: async ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'updatedAt'> }) => {
        if (
          rows.some(
            (r) =>
              r.tenantId === data.tenantId &&
              r.userId === data.userId &&
              r.name === data.name,
          )
        ) {
          throw { code: 'P2002' };
        }
        const now = new Date();
        const row: Row = { ...data, id: `a${++seq}`, createdAt: now, updatedAt: now };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('missing');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error('missing');
        rows.splice(i, 1);
      },
    },
    kbDoc: {
      count: async ({
        where,
      }: {
        where: {
          id: { in: string[] };
          tenantId: string;
          userId: string;
        };
      }) =>
        docs.filter(
          (d) =>
            where.id.in.includes(d.id) &&
            d.tenantId === where.tenantId &&
            d.userId === where.userId,
        ).length,
    },
  } as unknown as PrismaService;
  return { svc: new AssistantsService(prisma), rows };
}

describe('AssistantsService 创建', () => {
  it('默认值、技能归一化与绑定文档', async () => {
    const { svc } = makeService();
    const a = await svc.create('t1', 'u1', {
      name: '  合同助手 ',
      skills: ['kb', 'web', 'kb'],
      kbDocIds: ['d1', 'd1', 'd2'],
    });
    expect(a.name).toBe('合同助手');
    expect(a.permissionMode).toBe('standard');
    expect(a.model).toBeNull();
    expect(a.skills).toEqual(['web', 'kb']);
    expect(a.kbDocIds).toEqual(['d1', 'd2']);
  });

  it('未知技能被拒绝', async () => {
    const { svc } = makeService();
    await expect(
      svc.create('t1', 'u1', { name: 'x', skills: ['hack'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('绑定非本人文档被拒绝', async () => {
    const { svc } = makeService();
    await expect(
      svc.create('t1', 'u1', { name: 'x', kbDocIds: ['dx'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('同名助手返回冲突', async () => {
    const { svc } = makeService();
    await svc.create('t1', 'u1', { name: '同名' });
    await expect(svc.create('t1', 'u1', { name: '同名' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('AssistantsService 更新与删除', () => {
  it('部分更新保留未提交字段', async () => {
    const { svc } = makeService();
    const a = await svc.create('t1', 'u1', {
      name: '原名称',
      systemPrompt: '原提示词',
      permissionMode: 'readonly',
    });
    const updated = await svc.update(a.id, 't1', 'u1', { name: '新名称' });
    expect(updated.name).toBe('新名称');
    expect(updated.systemPrompt).toBe('原提示词');
    expect(updated.permissionMode).toBe('readonly');
  });

  it('空补丁被拒绝', async () => {
    const { svc } = makeService();
    const a = await svc.create('t1', 'u1', { name: 'a' });
    await expect(svc.update(a.id, 't1', 'u1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('跨用户不可见、不可改、不可删', async () => {
    const { svc } = makeService();
    const a = await svc.create('t1', 'u1', { name: 'a' });
    await expect(svc.update(a.id, 't2', 'u2', { name: 'b' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.remove(a.id, 't2', 'u2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('删除后列表不再返回', async () => {
    const { svc } = makeService();
    const a = await svc.create('t1', 'u1', { name: 'a' });
    await svc.remove(a.id, 't1', 'u1');
    expect(await svc.list('t1', 'u1')).toEqual([]);
  });
});
