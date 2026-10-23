import 'reflect-metadata';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminModelsController } from './admin-models.controller';
import { AdminModelsService } from './admin-models.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const calls: unknown[][] = [];
const fakeService = {
  catalog: async () => ({ providers: [], models: [], defaultModel: null, fallback: { active: true, providers: [] } }),
  createProvider: async (...args: unknown[]) => {
    calls.push(['createProvider', ...args]);
    return { id: 'p1' };
  },
  updateProvider: async (...args: unknown[]) => {
    calls.push(['updateProvider', ...args]);
    return { id: 'p1' };
  },
  removeProvider: async (...args: unknown[]) => {
    calls.push(['removeProvider', ...args]);
  },
  createModel: async (...args: unknown[]) => {
    calls.push(['createModel', ...args]);
    return { model: 'm1' };
  },
  updateModel: async (...args: unknown[]) => {
    calls.push(['updateModel', ...args]);
    return { model: 'm/1' };
  },
  removeModel: async (...args: unknown[]) => {
    calls.push(['removeModel', ...args]);
  },
  testModel: async (...args: unknown[]) => {
    calls.push(['testModel', ...args]);
    return { ok: true, latencyMs: 1 };
  },
  setDefault: async (...args: unknown[]) => {
    calls.push(['setDefault', ...args]);
    return { providers: [], models: [], defaultModel: 'm1', fallback: { active: false, providers: [] } };
  },
} as unknown as AdminModelsService;

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'admin' ? 'admin' : 'member',
      tenantId: 't1',
      email: `${where.id}@test.local`,
    }),
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;
const auth = (sub: string) => ({ authorization: `Bearer ${signToken({ sub, tenantId: 't1' })}` });

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminModelsController],
    providers: [
      { provide: AdminModelsService, useValue: fakeService },
      { provide: PrismaService, useValue: fakePrisma },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('AdminModelsController', () => {
  it('未登录 401，普通成员 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/models' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/models', headers: auth('u1') })).statusCode,
    ).toBe(403);
  });

  it('模型更新与删除走请求体/查询参数', async () => {
    calls.length = 0;
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/admin/models',
      headers: auth('admin'),
      payload: { model: 'm/1', enabled: true },
    });
    expect(patch.statusCode).toBe(200);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/admin/models?model=m%2F1',
      headers: auth('admin'),
    });
    expect(del.statusCode).toBe(204);
    expect(calls[0][0]).toBe('updateModel');
    expect(calls[0][1]).toEqual({ model: 'm/1', enabled: true });
    expect(calls[1][0]).toBe('removeModel');
    expect(calls[1][1]).toBe('m/1');
  });

  it('厂商、测试与默认模型路由均可达', async () => {
    calls.length = 0;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/model-providers',
          headers: auth('admin'),
          payload: { name: 'x', baseUrl: 'https://x/v1', apiKey: 'k' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/models/test',
          headers: auth('admin'),
          payload: { model: 'm1' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/admin/default-model',
          headers: auth('admin'),
          payload: { model: 'm1' },
        })
      ).statusCode,
    ).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(['createProvider', 'testModel', 'setDefault']);
  });
});
