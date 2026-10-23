import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminPlansController } from './admin-plans.controller';
import { AdminSessionsController } from './admin-sessions.controller';
import { AdminTasksController } from './admin-tasks.controller';
import { AdminModelsController } from './admin-models.controller';
import { AdminObservabilityController } from './admin-observability.controller';
import { AdminObservabilityService } from './admin-observability.service';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';
import { AdminKbController } from './admin-kb.controller';
import { AdminTasksService } from './admin-tasks.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

/** 用户查询桩：管理员（id=admin）与普通成员（其余 id）共用。 */
const fakePrismaUserFindUnique = async ({ where }: { where: { id: string } }) => ({
  status: 'active',
  role: where.id === 'admin' ? 'admin' : 'member',
  tenantId: 't1',
  email: `${where.id}@test.local`,
});

const fakePrisma = {
  user: { findUnique: fakePrismaUserFindUnique },
  adminAuditLog: {
    findMany: async () => [],
    count: async () => 0,
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminAuditController],
    providers: [AuditService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('管理端鉴权', () => {
  it('普通成员访问 /api/admin/audit 返回 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('管理员访问返回分页结构', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('禁用管理员返回 401', async () => {
    const prisma = fakePrisma as unknown as { user: { findUnique: () => Promise<unknown> } };
    const original = prisma.user.findUnique;
    try {
      prisma.user.findUnique = async () => ({
        status: 'disabled',
        role: 'admin',
        tenantId: 't1',
        email: 'admin@test.local',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/audit',
        headers: { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      // 断言失败也必须恢复桩，避免污染后续用例。
      prisma.user.findUnique = original;
    }
  });
});

describe('AppModule 装配', () => {
  it('管理端 11 个控制器均已装配', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .compile();
    try {
      expect(moduleRef.get(AdminUsersController)).toBeInstanceOf(AdminUsersController);
      expect(moduleRef.get(AdminTenantsController)).toBeInstanceOf(AdminTenantsController);
      expect(moduleRef.get(AdminPlansController)).toBeInstanceOf(AdminPlansController);
      expect(moduleRef.get(AdminSessionsController)).toBeInstanceOf(AdminSessionsController);
      expect(moduleRef.get(AdminTasksController)).toBeInstanceOf(AdminTasksController);
      expect(moduleRef.get(AdminModelsController)).toBeInstanceOf(AdminModelsController);
      expect(moduleRef.get(AdminSettingsController)).toBeInstanceOf(AdminSettingsController);
      expect(moduleRef.get(AdminAuditController)).toBeInstanceOf(AdminAuditController);
      expect(moduleRef.get(AdminObservabilityController)).toBeInstanceOf(
        AdminObservabilityController,
      );
      expect(moduleRef.get(AdminAlertsController)).toBeInstanceOf(AdminAlertsController);
      expect(moduleRef.get(AdminKbController)).toBeInstanceOf(AdminKbController);
    } finally {
      await moduleRef.close();
    }
  });
});

type SettingRow = { key: string; value: unknown; updatedBy: string | null; updatedAt: Date };

/** 参数接口测试用的 Prisma 桩：用户鉴权 + 内存参数存储 + 审计。 */
const settingsStore = new Map<string, SettingRow>();

const settingsDb = {
  user: { findUnique: fakePrismaUserFindUnique },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) =>
      settingsStore.get(where.key) ?? null,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string; value: unknown; updatedBy: string };
      update: { value: unknown; updatedBy: string };
    }) => {
      const row: SettingRow = {
        key: where.key,
        value: create.value ?? update.value,
        updatedBy: update.updatedBy ?? create.updatedBy,
        updatedAt: new Date(),
      };
      settingsStore.set(where.key, row);
      return row;
    },
    deleteMany: async ({ where }: { where: { key: string } }) => {
      settingsStore.delete(where.key);
      return { count: 1 };
    },
  },
  adminAuditLog: { create: async () => ({}) },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(settingsDb),
};

const settingsPrisma = settingsDb as unknown as PrismaService;

describe('参数配置接口', () => {
  let settingsApp: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminSettingsController],
      providers: [
        SettingsService,
        AuditService,
        { provide: PrismaService, useValue: settingsPrisma },
      ],
    }).compile();
    settingsApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await settingsApp.init();
    await settingsApp.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await settingsApp.close();
  });

  beforeEach(() => {
    settingsStore.clear();
  });

  const auth = (sub: string) => ({
    authorization: `Bearer ${signToken({ sub, tenantId: 't1' })}`,
  });

  it('管理员更新参数后返回 DB 来源', async () => {
    const res = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/maxRounds',
      headers: auth('admin'),
      payload: { value: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({
      key: 'maxRounds',
      value: 4,
      source: 'db',
      updatedBy: 'admin',
    });
  });

  it('管理员恢复默认后回到 default 来源', async () => {
    await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/maxRounds',
      headers: auth('admin'),
      payload: { value: 4 },
    });

    const res = await settingsApp.inject({
      method: 'DELETE',
      url: '/api/admin/settings/maxRounds',
      headers: auth('admin'),
    });
    expect(res.statusCode).toBe(204);

    const list = await settingsApp.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: auth('admin'),
    });
    expect(list.statusCode).toBe(200);
    const maxRounds = (JSON.parse(list.payload) as Array<Record<string, unknown>>).find(
      (s) => s.key === 'maxRounds',
    );
    // maxRounds 无 env 兜底，删除覆盖后应回到默认值与 default 来源。
    expect(maxRounds).toMatchObject({ value: 8, source: 'default' });
  });

  it('缺少 value 返回 400 invalid_value', async () => {
    const res = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/maxRounds',
      headers: auth('admin'),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ message: 'invalid_value' });
  });

  it('普通成员更新参数返回 403', async () => {
    const res = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/maxRounds',
      headers: auth('u1'),
      payload: { value: 4 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('未知参数 key 返回 404 setting_not_found', async () => {
    const res = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/unknownKey',
      headers: auth('admin'),
      payload: { value: 4 },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toMatchObject({ message: 'setting_not_found' });
  });

  it('布尔与 secret 参数按类型返回，secret 不泄露明文', async () => {
    const enabled = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/alertsEnabled',
      headers: auth('admin'),
      payload: { value: false },
    });
    expect(enabled.statusCode).toBe(200);
    expect(JSON.parse(enabled.payload)).toMatchObject({
      key: 'alertsEnabled',
      type: 'boolean',
      value: false,
      source: 'db',
    });

    const secret = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/alertWebhookSecret',
      headers: auth('admin'),
      payload: { value: 'secret-token-9876' },
    });
    expect(secret.statusCode).toBe(200);
    expect(JSON.parse(secret.payload)).toMatchObject({
      type: 'secret',
      configured: true,
      maskedValue: '****9876',
    });
    expect(secret.payload).not.toContain('secret-token-9876');
  });

  it('类型不匹配返回 400 invalid_value', async () => {
    const res = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/alertsEnabled',
      headers: auth('admin'),
      payload: { value: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ message: 'invalid_value' });
  });
});

describe('�������澯��ʱ���߽ӿڼ�Ȩ', () => {
  let adminApp: NestFastifyApplication;
  const overviewStub = {
    overview: async () => ({ range: '24h' }),
    timeseries: async () => ({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      granularity: 'hour',
      series: [],
    }),
  };
  const alertsStub = {
    listRules: async () => [],
    updateRule: async () => ({ id: 'r1' }),
    listEvents: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    sendTest: async () => ({
      deliveryStatus: 'skipped',
      deliveryError: 'webhook_not_configured',
      notifiedAt: null,
    }),
  };
  const tasksStub = { runTimeline: async () => ({ runId: 'r1', nodes: [] }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminObservabilityController, AdminAlertsController, AdminTasksController],
      providers: [
        { provide: AdminObservabilityService, useValue: overviewStub },
        { provide: AdminAlertsService, useValue: alertsStub },
        { provide: AdminTasksService, useValue: tasksStub },
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    adminApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await adminApp.init();
    await adminApp.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await adminApp.close();
  });

  const routes: Array<{ method: 'GET' | 'PATCH' | 'POST'; url: string; payload?: unknown }> = [
    { method: 'GET', url: '/api/admin/overview' },
    {
      method: 'GET',
      url: '/api/admin/metrics/timeseries?metrics=runs_started&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z',
    },
    { method: 'GET', url: '/api/admin/alert-rules' },
    { method: 'PATCH', url: '/api/admin/alert-rules/r1', payload: { enabled: true } },
    { method: 'GET', url: '/api/admin/alert-events' },
    { method: 'POST', url: '/api/admin/alert-rules/r1/test' },
    { method: 'GET', url: '/api/admin/runs/r1/timeline' },
  ];

  it('��ͨ��Ա���������ӿ�ȫ������ 403', async () => {
    const headers = { authorization: `Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}` };
    for (const route of routes) {
      const res = await adminApp.inject({ ...route, headers });
      expect(res.statusCode).toBe(403);
    }
  });

  it('����Ա�ɷ��ʸ������澯������ʱ����', async () => {
    const headers = { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` };
    const overviewRes = await adminApp.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers,
    });
    expect(overviewRes.statusCode).toBe(200);
    expect(JSON.parse(overviewRes.payload)).toMatchObject({ range: '24h' });

    const rulesRes = await adminApp.inject({
      method: 'GET',
      url: '/api/admin/alert-rules',
      headers,
    });
    expect(rulesRes.statusCode).toBe(200);
    expect(JSON.parse(rulesRes.payload)).toEqual([]);

    const timelineRes = await adminApp.inject({
      method: 'GET',
      url: '/api/admin/runs/r1/timeline',
      headers,
    });
    expect(timelineRes.statusCode).toBe(200);
    expect(JSON.parse(timelineRes.payload)).toMatchObject({ runId: 'r1' });
  });
});
