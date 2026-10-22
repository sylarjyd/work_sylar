import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModelCatalogService } from './model-catalog.service';
import { encryptSecret } from '../secrets/secret-box';
import {
  ModelPlanExpiredError,
  ModelProviderUnavailableError,
  ModelUnavailableError,
  NoModelsAvailableError,
} from './model.errors';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../db/prisma.service';

const KEY = 'c'.repeat(64);
// dbProvider 在模块求值期加密，早于 beforeEach，这里先提供密钥。
process.env.MODEL_ENC_KEY = KEY;

beforeEach(() => {
  process.env.MODEL_ENC_KEY = KEY;
  delete process.env.MODEL_PROVIDERS;
  delete process.env.DEEPSEEK_API_KEY;
});

function makeService(opts: {
  providers?: { id: string; name: string; baseUrl: string; apiKeyEnc: string }[];
  models?: { model: string; providerId: string | null; enabled: boolean; sortOrder: number; displayName: string | null; inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number; updatedAt: Date }[];
  allowed?: string[];
  defaultModel?: string | null;
  expired?: boolean;
} = {}) {
  const providers = opts.providers ?? [];
  const models = opts.models ?? [];
  const prisma = {
    modelProvider: {
      count: async () => providers.length,
      findMany: async () => [],
    },
    modelConfig: {
      // 模拟 Prisma orderBy: [{ sortOrder: 'asc' }, { model: 'asc' }]。
      findMany: async () =>
        [...models]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.model.localeCompare(b.model))
          .map((m) => ({ ...m, provider: providers.find((p) => p.id === m.providerId) ?? null })),
    },
    setting: {
      findUnique: async () =>
        opts.defaultModel ? { key: 'defaultModel', value: opts.defaultModel } : null,
    },
  } as unknown as PrismaService;
  const billing = {
    ensureSubscription: async () => ({
      plan: { id: 'free', allowedModels: opts.allowed ?? ['m1', 'm2'] },
      sub: {
        status: opts.expired ? 'expired' : 'active',
        periodEnd: opts.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 86_400_000),
      },
    }),
  } as unknown as BillingService;
  return new ModelCatalogService(prisma, billing);
}

const dbProvider = {
  id: 'p1',
  name: '豆包',
  baseUrl: 'https://ark.example/v3',
  apiKeyEnc: encryptSecret('sk-ark', 'MODEL_ENC_KEY'),
};

const dbModels = [
  {
    model: 'm2',
    providerId: 'p1',
    enabled: true,
    sortOrder: 20,
    displayName: '模型二',
    inputMilliCreditsPer1k: 1,
    outputMilliCreditsPer1k: 2,
    updatedAt: new Date(),
  },
  {
    model: 'm1',
    providerId: 'p1',
    enabled: true,
    sortOrder: 10,
    displayName: null,
    inputMilliCreditsPer1k: 3,
    outputMilliCreditsPer1k: 4,
    updatedAt: new Date(),
  },
  {
    model: 'm3',
    providerId: 'p1',
    enabled: true,
    sortOrder: 30,
    displayName: '不在套餐',
    inputMilliCreditsPer1k: 1,
    outputMilliCreditsPer1k: 1,
    updatedAt: new Date(),
  },
];

describe('ModelCatalogService', () => {
  it('数据库厂商优先，与套餐交集并按 sortOrder 排序', async () => {
    const svc = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2', 'm3', 'legacy'],
    });
    const out = await svc.listForClient('t1');
    expect(out.models.map((m) => m.model)).toEqual(['m1', 'm2', 'm3']);
    expect(out.models[0]).toEqual({ model: 'm1', displayName: 'm1', providerName: '豆包' });
  });

  it('默认模型取运营端设置；不在可用列表时回退第一项', async () => {
    const chosen = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2'],
      defaultModel: 'm2',
    });
    expect((await chosen.listForClient('t1')).defaultModel).toBe('m2');

    const stale = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2'],
      defaultModel: 'gone',
    });
    expect((await stale.listForClient('t1')).defaultModel).toBe('m1');
  });

  it('套餐过期返回 402', async () => {
    const svc = makeService({ expired: true });
    await expect(svc.listForClient('t1')).rejects.toBeInstanceOf(ModelPlanExpiredError);
  });

  it('没有数据库厂商时回退环境变量；无密钥时展示套餐模型供 Mock 使用', async () => {
    process.env.MODEL_PROVIDERS = JSON.stringify([
      { model: 'm1', baseUrl: 'https://env/v1', apiKeyEnv: 'ENV_KEY' },
      { model: 'm2', baseUrl: 'https://env/v1', apiKeyEnv: 'ENV_KEY' },
    ]);
    process.env.ENV_KEY = 'sk-env';
    const envSvc = makeService({ allowed: ['m1', 'm2', 'm3'] });
    const out = await envSvc.listForClient('t1');
    expect(out.models.map((m) => m.model)).toEqual(['m1', 'm2']);
    expect(out.models[0].providerName).toBe('环境变量');

    delete process.env.ENV_KEY;
    const mockSvc = makeService({ allowed: ['m1', 'm2'] });
    expect((await mockSvc.listForClient('t1')).models.map((m) => m.model)).toEqual(['m1', 'm2']);
  });

  it('resolveForRun 把选中模型排第一并解密厂商密钥', async () => {
    const svc = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2'],
      defaultModel: 'm2',
    });
    const out = await svc.resolveForRun('t1', null);
    expect(out.selectedModel).toBe('m2');
    expect(out.modelRoutes).toEqual([
      { model: 'm2', baseUrl: 'https://ark.example/v3', apiKey: 'sk-ark' },
      { model: 'm1', baseUrl: 'https://ark.example/v3', apiKey: 'sk-ark' },
    ]);
  });

  it('会话选定模型不在可用列表返回 409；无可用模型返回 400', async () => {
    const svc = makeService({ providers: [dbProvider], models: dbModels, allowed: ['m1', 'm2'] });
    await expect(svc.resolveForRun('t1', 'gone')).rejects.toBeInstanceOf(ModelUnavailableError);

    const empty = makeService({ providers: [], models: [], allowed: [] });
    await expect(empty.resolveForRun('t1', null)).rejects.toBeInstanceOf(NoModelsAvailableError);
  });

  it('选中模型密钥损坏返回 503；其它厂商密钥损坏只跳过该路由', async () => {
    const broken = { ...dbProvider, apiKeyEnc: 'not-a-valid-blob' };
    const selected = makeService({
      providers: [broken],
      models: dbModels.slice(0, 1),
      allowed: ['m2'],
    });
    await expect(selected.resolveForRun('t1', 'm2')).rejects.toBeInstanceOf(
      ModelProviderUnavailableError,
    );

    // 选中模型 m2 在健康厂商 p1，回退模型 m3 在密钥损坏的 p2：
    // 本次运行应当成功，只丢掉 m3 这条回退路由。
    const fallbackBroken = makeService({
      providers: [
        dbProvider,
        {
          id: 'p2',
          name: '千问',
          baseUrl: 'https://dashscope.example/v1',
          apiKeyEnc: 'not-a-valid-blob',
        },
      ],
      models: [dbModels[0], { ...dbModels[2], providerId: 'p2' }],
      allowed: ['m2', 'm3'],
    });
    const out = await fallbackBroken.resolveForRun('t1', 'm2');
    expect(out.selectedModel).toBe('m2');
    expect(out.modelRoutes).toEqual([
      { model: 'm2', baseUrl: 'https://ark.example/v3', apiKey: 'sk-ark' },
    ]);
  });
});
