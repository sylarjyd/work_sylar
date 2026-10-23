import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { ModelUnavailableError } from '../models/model.errors';
import type { ModelCatalogService } from '../models/model-catalog.service';
import type { PrismaService } from '../db/prisma.service';

interface AssistantFixture {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  systemPrompt: string;
  permissionMode: string;
  model: string | null;
  skills: string[];
  kbIds: string[];
}

const ASSISTANT: AssistantFixture = {
  id: 'a1',
  tenantId: 't1',
  userId: 'u1',
  name: '合同助手',
  systemPrompt: '你是合同审阅助手',
  permissionMode: 'readonly',
  model: 'm2',
  skills: ['kb', 'web'],
  kbIds: ['b1'],
};

const all = [
  {
    id: 's1',
    tenantId: 't1',
    userId: 'u1',
    title: 'active',
    status: 'active',
    model: 'm1',
    assistantId: 'a1',
    createdAt: new Date(),
  },
  {
    id: 's2',
    tenantId: 't1',
    userId: 'u1',
    title: 'archived',
    status: 'archived',
    model: null,
    assistantId: null,
    createdAt: new Date(),
  },
  {
    id: 's3',
    tenantId: 't1',
    userId: 'u1',
    title: 'default',
    status: 'active',
    model: 'm1',
    assistantId: null,
    createdAt: new Date(),
  },
];

function withAssistant<T extends { assistantId: string | null }>(s: T) {
  return {
    ...s,
    assistant: s.assistantId === ASSISTANT.id ? { name: ASSISTANT.name } : null,
  };
}

function makeService(
  models = ['m1', 'm2'],
  defaultModel: string | null = 'm1',
  assistants: AssistantFixture[] = [ASSISTANT],
) {
  const created: { model?: string; assistantId?: string | null }[] = [];
  const prisma = {
    session: {
      findMany: async ({
        where,
      }: {
        where: { tenantId: string; userId: string; status?: { not: string } };
      }) =>
        all
          .filter(
            (s) =>
              s.tenantId === where.tenantId &&
              s.userId === where.userId &&
              (!where.status?.not || s.status !== where.status.not),
          )
          .map(withAssistant),
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string; userId: string; status?: { not: string } };
      }) => {
        const row =
          all.find(
            (s) =>
              s.id === where.id &&
              s.tenantId === where.tenantId &&
              s.userId === where.userId &&
              (!where.status?.not || s.status !== where.status.not),
          ) ?? null;
        if (!row) return null;
        return {
          ...row,
          assistant:
            row.assistantId === ASSISTANT.id
              ? assistants.find((a) => a.id === ASSISTANT.id) ?? null
              : null,
        };
      },
      create: async ({
        data,
      }: {
        data: {
          tenantId: string;
          userId: string;
          title: string;
          model?: string;
          assistantId?: string | null;
        };
      }) => {
        created.push({ model: data.model, assistantId: data.assistantId });
        return {
          id: 's4',
          createdAt: new Date(),
          ...data,
          assistant:
            data.assistantId === ASSISTANT.id ? { name: ASSISTANT.name } : null,
        };
      },
    },
    assistant: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string; userId: string };
      }) =>
        assistants.find(
          (a) =>
            a.id === where.id && a.tenantId === where.tenantId && a.userId === where.userId,
        ) ?? null,
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
  it('list 不返回归档会话，并带出会话模型与助手名', async () => {
    const list = await makeService().svc.list('t1', 'u1');
    expect(list.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(list[0].model).toBe('m1');
    expect(list[0].assistantId).toBe('a1');
    expect(list[0].assistantName).toBe('合同助手');
    expect(list[1].assistantName).toBeNull();
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
    expect(created).toEqual([{ model: 'm1', assistantId: null }]);
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
    expect(created).toEqual([{ model: 'm2', assistantId: null }]);
  });

  it('未显式选模时使用助手默认模型，并绑定助手', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { assistantId: 'a1' });
    expect(s.model).toBe('m2');
    expect(s.assistantName).toBe('合同助手');
    expect(created).toEqual([{ model: 'm2', assistantId: 'a1' }]);
  });

  it('显式模型优先于助手默认模型', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { assistantId: 'a1', model: 'm1' });
    expect(s.model).toBe('m1');
    expect(created).toEqual([{ model: 'm1', assistantId: 'a1' }]);
  });

  it('绑定他人/不存在的助手一律 404', async () => {
    const { svc, created } = makeService();
    await expect(svc.create('t2', 'u2', { assistantId: 'a1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(created).toEqual([]);
  });

  it('assertOwned 返回会话模型与助手配置供运行时解析', async () => {
    const ref = await makeService().svc.assertOwned('s1', 't1', 'u1');
    expect(ref).toEqual({
      id: 's1',
      model: 'm1',
      assistantId: 'a1',
      assistantName: '合同助手',
      assistant: {
        id: 'a1',
        name: '合同助手',
        systemPrompt: '你是合同审阅助手',
        permissionMode: 'readonly',
        skills: ['web', 'kb'],
        kbIds: ['b1'],
      },
    });
  });
});
