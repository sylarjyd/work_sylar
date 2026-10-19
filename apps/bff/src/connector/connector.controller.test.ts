import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConnectorController } from './connector.controller';
import { InternalConnectorController } from './internal-connector.controller';
import { ConnectorService } from './connector.service';
import { PrismaService } from '../db/prisma.service';
import { AdminGuard } from '../auth/admin.guard';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;
let roles: Record<string, string>;
const created: Record<string, unknown>[] = [];
let validateOk = true;

const fakePrisma = {
  user: {
    // JwtGuard 会按 sub 查库校验 status/role；测试里按 token 中的 sub 返回对应角色。
    findUnique: async ({ where }: { where: { id: string } }) =>
      roles[where.id]
        ? { status: 'active', role: roles[where.id], tenantId: 't1', email: `${where.id}@test.local` }
        : null,
  },
  connector: {
    findFirst: async () => null,
    findMany: async () => [],
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'c1', toolCount: 0, lastValidatedAt: null, enabled: true, createdAt: new Date(), updatedAt: new Date(), ...data };
      created.push(row);
      return row;
    },
    update: async () => ({}),
    delete: async () => ({}),
  },
} as unknown as PrismaService;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.CONNECTOR_ENC_KEY = 'a'.repeat(64);
  const moduleRef = await Test.createTestingModule({
    controllers: [ConnectorController, InternalConnectorController],
    providers: [
      AdminGuard,
      { provide: PrismaService, useValue: fakePrisma },
      {
        provide: ConnectorService,
        useFactory: () =>
          new ConnectorService(fakePrisma, {
            runtimeUrl: 'http://runtime',
            fetchImpl: (async () =>
              new Response(JSON.stringify(validateOk ? { ok: true, tools: [{ name: 'echo', description: '', inputSchema: {} }] } : { ok: false, error: 'spawn_failed' }), { status: 200 })) as unknown as typeof fetch,
          }),
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => { await app.close(); });
beforeEach(() => { roles = { admin1: 'admin', member1: 'member' }; created.length = 0; validateOk = true; delete process.env.INTERNAL_TOKEN; });

const auth = (sub: string) => ({ authorization: `Bearer ${signToken({ sub, tenantId: 't1' })}` });

describe('ConnectorController', () => {
  it('未鉴权 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/connectors' })).statusCode).toBe(401);
  });

  it('非管理员 403 not_admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connectors', headers: auth('member1') });
    expect(res.statusCode).toBe(403);
  });

  it('管理员创建 201 且返回 toolCount', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/connectors', headers: auth('admin1'),
      payload: { name: 'echo', command: 'node', args: ['s.mjs'], env: { K: 'v' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'echo', toolCount: 1 });
    expect((res.json() as { env?: unknown }).env).toBeUndefined();
    expect(created).toHaveLength(1);
  });

  it('校验失败 400 validate_failed', async () => {
    validateOk = false;
    const res = await app.inject({ method: 'POST', url: '/api/connectors', headers: auth('admin1'), payload: { name: 'bad', command: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'validate_failed' });
  });
});

describe('InternalConnectorController', () => {
  it('token 不符 401', async () => {
    process.env.INTERNAL_TOKEN = 'sekret';
    const res = await app.inject({ method: 'GET', url: '/internal/connectors?tenantId=t1' });
    expect(res.statusCode).toBe(401);
  });

  it('token 正确返回数组', async () => {
    process.env.INTERNAL_TOKEN = 'sekret';
    const res = await app.inject({ method: 'GET', url: '/internal/connectors?tenantId=t1', headers: { 'x-internal-token': 'sekret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('未配 token 时仅回环放行', async () => {
    delete process.env.INTERNAL_TOKEN;
    const res = await app.inject({ method: 'GET', url: '/internal/connectors?tenantId=t1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('缺 tenantId 400 missing_tenant', async () => {
    process.env.INTERNAL_TOKEN = 'sekret';
    const res = await app.inject({ method: 'GET', url: '/internal/connectors', headers: { 'x-internal-token': 'sekret' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'missing_tenant' });
  });
});
