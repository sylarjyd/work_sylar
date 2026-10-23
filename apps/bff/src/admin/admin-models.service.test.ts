import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminModelsService } from './admin-models.service';
import { encryptSecret, decryptSecret } from '../secrets/secret-box';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };
const KEY = 'd'.repeat(64);

beforeEach(() => {
  process.env.MODEL_ENC_KEY = KEY;
  delete process.env.MODEL_PROVIDERS;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MODEL_ALLOW_PRIVATE_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function p2002() {
  return Object.assign(new Error('unique'), { code: 'P2002' });
}

function p2003() {
  return Object.assign(new Error('fk'), { code: 'P2003' });
}

interface FakeProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnc: string;
  apiKeyHint: string | null;
  createdAt: Date;
}

interface FakeModel {
  model: string;
  providerId: string | null;
  displayName: string | null;
  enabled: boolean;
  sortOrder: number;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  updatedAt: Date;
}

function makeService(
  opts: {
    planInUse?: boolean;
    subInUse?: boolean;
    allowPrivate?: boolean;
    resolver?: (hostname: string) => Promise<string[]>;
  } = {},
) {
  const providers = new Map<string, FakeProvider>();
  providers.set('p1', {
    id: 'p1',
    name: '豆包',
    baseUrl: 'https://ark.example/v3',
    apiKeyEnc: encryptSecret('sk-ark-1234', 'MODEL_ENC_KEY'),
    apiKeyHint: '****1234',
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  const models = new Map<string, FakeModel>();
  models.set('m1', {
    model: 'm1',
    providerId: 'p1',
    displayName: null,
    enabled: true,
    sortOrder: 10,
    inputMilliCreditsPer1k: 100,
    outputMilliCreditsPer1k: 200,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });
  let defaultModel: string | null = 'm1';
  const audits: unknown[] = [];

  const withProvider = (m: FakeModel) => ({
    ...m,
    provider: m.providerId ? (providers.get(m.providerId) ?? null) : null,
  });

  const db = {
    modelProvider: {
      count: async () => providers.size,
      findMany: async () =>
        [...providers.values()].map((p) => ({
          ...p,
          _count: { models: [...models.values()].filter((m) => m.providerId === p.id).length },
        })),
      findUnique: async ({ where }: { where: { id: string } }) => providers.get(where.id) ?? null,
      create: async ({ data }: { data: { name: string; baseUrl: string; apiKeyEnc: string; apiKeyHint: string } }) => {
        if ([...providers.values()].some((p) => p.name === data.name)) throw p2002();
        const row = {
          id: `p${providers.size + 1}`,
          createdAt: new Date('2026-10-20T00:00:00Z'),
          ...data,
        };
        providers.set(row.id, row);
        return { ...row, _count: { models: 0 } };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ name: string; baseUrl: string; apiKeyEnc: string; apiKeyHint: string }> }) => {
        const prev = providers.get(where.id);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        const row = { ...prev, ...data };
        providers.set(where.id, row);
        return {
          ...row,
          _count: { models: [...models.values()].filter((m) => m.providerId === row.id).length },
        };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const prev = providers.get(where.id);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        providers.delete(where.id);
        return prev;
      },
    },
    modelConfig: {
      count: async ({ where }: { where: { providerId: string } }) =>
        [...models.values()].filter((m) => m.providerId === where.providerId).length,
      findMany: async () =>
        [...models.values()]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.model.localeCompare(b.model))
          .map(withProvider),
      findUnique: async ({ where }: { where: { model: string } }) => {
        const row = models.get(where.model);
        return row ? withProvider(row) : null;
      },
      create: async ({
        data,
      }: {
        data: Omit<FakeModel, 'updatedAt'> & { providerId: string };
      }) => {
        if (models.has(data.model)) throw p2002();
        if (!providers.has(data.providerId)) throw p2003();
        const row: FakeModel = { ...data, updatedAt: new Date('2026-10-20T00:00:00Z') };
        models.set(row.model, row);
        return withProvider(row);
      },
      update: async ({
        where,
        data,
      }: {
        where: { model: string };
        data: Partial<Omit<FakeModel, 'model' | 'updatedAt'>>;
      }) => {
        const prev = models.get(where.model);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        if (typeof data.providerId === 'string' && !providers.has(data.providerId)) throw p2003();
        const row = { ...prev, ...data, updatedAt: new Date('2026-10-20T00:00:00Z') };
        models.set(where.model, row);
        return withProvider(row);
      },
      delete: async ({ where }: { where: { model: string } }) => {
        const prev = models.get(where.model);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        models.delete(where.model);
        return prev;
      },
    },
    plan: {
      findFirst: async () => (opts.planInUse ? { id: 'pro' } : null),
    },
    subscription: {
      findFirst: async () => (opts.subInUse ? { tenantId: 't1' } : null),
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === 'defaultModel' && defaultModel
          ? { key: where.key, value: defaultModel, updatedBy: null, updatedAt: new Date() }
          : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        defaultModel = create.value;
        return { key: where.key, ...create };
      },
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      models.has(values[0] as string) ? [{ model: values[0] }] : [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  const urlOptions = {
    env: {
      ...process.env,
      ...(opts.allowPrivate ? { MODEL_ALLOW_PRIVATE_BASE_URL: '1' } : {}),
    },
    // 默认把所有域名解析成公网地址，避免单测依赖真实 DNS。
    resolveHosts: opts.resolver ?? (async () => ['93.184.216.34']),
  };
  return {
    svc: new AdminModelsService(db, audit, urlOptions),
    audits,
    providers,
    models,
    getDefault: () => defaultModel,
  };
}

describe('AdminModelsService', () => {
  it('catalog 不返回密钥，并标记默认模型与环境兜底', async () => {
    const { svc } = makeService();
    const out = await svc.catalog();
    expect(out.providers[0]).toMatchObject({ id: 'p1', name: '豆包', apiKeyHint: '****1234', modelCount: 1 });
    expect(out.models[0]).toMatchObject({ model: 'm1', providerName: '豆包', isDefault: true });
    expect(out.defaultModel).toBe('m1');
    expect(out.fallback.active).toBe(false);
    expect(JSON.stringify(out)).not.toContain('sk-ark-1234');
  });

  it('创建厂商时加密且只记录尾号，审计不含密钥', async () => {
    const { svc, audits, providers } = makeService();
    const created = await svc.createProvider(
      { name: '千问', baseUrl: 'https://dash.example/v1/', apiKey: 'sk-qwen-9999' },
      actor,
    );
    expect(created.baseUrl).toBe('https://dash.example/v1');
    expect(created.apiKeyHint).toBe('****9999');
    const row = [...providers.values()].find((p) => p.name === '千问')!;
    expect(row.apiKeyEnc).not.toContain('sk-qwen-9999');
    expect(decryptSecret(row.apiKeyEnc, 'MODEL_ENC_KEY')).toBe('sk-qwen-9999');
    expect(audits[0]).toMatchObject({ action: 'modelProvider.create', targetType: 'modelProvider' });
    expect(JSON.stringify(audits)).not.toContain('sk-qwen-9999');
  });

  it('重复厂商返回 409', async () => {
    const { svc } = makeService();
    await expect(
      svc.createProvider({ name: '豆包', baseUrl: 'https://x/v1', apiKey: 'sk' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('默认拒绝回环、内网与链路本地厂商地址', async () => {
    const { svc } = makeService();
    for (const baseUrl of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'https://10.1.2.3/v1',
      'http://169.254.169.254/latest',
      'http://[::1]:11434/v1',
    ]) {
      await expect(
        svc.createProvider({ name: `p-${baseUrl}`, baseUrl, apiKey: 'sk-x-1234' }, actor),
      ).rejects.toMatchObject({ message: 'provider_url_blocked' });
    }
  });

  it('域名解析到内网地址同样拒绝，开启内网开关后才放行', async () => {
    const { svc } = makeService({ resolver: async () => ['10.0.0.8'] });
    await expect(
      svc.createProvider(
        { name: '内网域名', baseUrl: 'https://models.internal.example/v1', apiKey: 'sk-x-1234' },
        actor,
      ),
    ).rejects.toMatchObject({ message: 'provider_url_blocked' });

    const allowed = makeService({
      allowPrivate: true,
      resolver: async () => ['10.0.0.8'],
    });
    const created = await allowed.svc.createProvider(
      { name: '内网域名', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-local-1234' },
      actor,
    );
    expect(created.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('即使开启内网开关也拒绝云元数据地址', async () => {
    const { svc } = makeService({ allowPrivate: true });
    await expect(
      svc.createProvider(
        { name: '元数据', baseUrl: 'http://169.254.169.254/latest', apiKey: 'sk-x-1234' },
        actor,
      ),
    ).rejects.toMatchObject({ message: 'provider_url_blocked' });
  });

  it('连通性测试会复核库中地址，直接改库也绕不过策略', async () => {
    const { svc, providers } = makeService();
    providers.get('p1')!.baseUrl = 'http://127.0.0.1:9/v1';
    await expect(svc.testModel({ model: 'm1' }, actor)).rejects.toMatchObject({
      message: 'provider_url_blocked',
    });
  });

  it('厂商仍有模型时拒绝删除', async () => {
    const { svc } = makeService();
    await expect(svc.removeProvider('p1', actor)).rejects.toMatchObject({
      message: 'provider_has_models',
    });
  });

  it('创建模型校验价格并写审计', async () => {
    const { svc, audits } = makeService();
    const dto = await svc.createModel(
      {
        model: 'm2',
        displayName: '模型二',
        providerId: 'p1',
        enabled: true,
        sortOrder: 20,
        prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 2 },
      },
      actor,
    );
    expect(dto).toMatchObject({ model: 'm2', providerName: '豆包', enabled: true, sortOrder: 20 });
    expect(audits.at(-1)).toMatchObject({ action: 'model.create', targetType: 'modelConfig' });

    await expect(
      svc.createModel(
        {
          model: 'm3',
          providerId: 'p1',
          prices: { inputMilliCreditsPer1k: -1, outputMilliCreditsPer1k: 2 },
        },
        actor,
      ),
    ).rejects.toMatchObject({ message: 'invalid_price' });
  });

  it('重复模型返回 409；厂商不存在返回 404', async () => {
    const { svc } = makeService();
    await expect(
      svc.createModel(
        { model: 'm1', providerId: 'p1', prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 } },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.createModel(
        { model: 'm9', providerId: 'missing', prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 } },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('停用默认模型被拒绝', async () => {
    const { svc } = makeService();
    await expect(svc.updateModel({ model: 'm1', enabled: false }, actor)).rejects.toMatchObject({
      message: 'default_model_in_use',
    });
  });

  it('删除默认模型被拒绝', async () => {
    const { svc } = makeService();
    await expect(svc.removeModel('m1', actor)).rejects.toMatchObject({
      message: 'default_model_in_use',
    });
  });

  it('删除被套餐或有效订阅引用的非默认模型被拒绝', async () => {
    for (const opts of [{ planInUse: true }, { subInUse: true }]) {
      const { svc } = makeService(opts);
      await svc.createModel(
        {
          model: 'm2',
          providerId: 'p1',
          prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
        },
        actor,
      );
      await expect(svc.removeModel('m2', actor)).rejects.toMatchObject({
        message: 'model_in_use',
      });
    }
  });

  it('设置默认模型要求模型存在且启用', async () => {
    const { svc, getDefault, audits } = makeService();
    await expect(svc.setDefault({ model: 'missing' }, actor)).rejects.toMatchObject({
      message: 'invalid_default_model',
    });
    await svc.updateModel({ model: 'm1', enabled: true }, actor);
    await svc.setDefault({ model: 'm1' }, actor);
    expect(getDefault()).toBe('m1');
    expect(audits.some((a) => (a as { action: string }).action === 'model.default')).toBe(true);
  });

  it('测试连接成功/失败均返回结果，且错误中的密钥被脱敏', async () => {
    const { svc } = makeService();
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    vi.stubGlobal('fetch', okFetch);
    await expect(svc.testModel({ model: 'm1' }, actor)).resolves.toMatchObject({ ok: true });
    // 上游厂商可被管理员配置为内网地址，但不允许重定向到其他主机，缩小 SSRF 面。
    expect((okFetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad sk-ark-1234', { status: 401 })),
    );
    const failed = await svc.testModel({ model: 'm1' }, actor);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('[REDACTED]');
    expect(failed.error).not.toContain('sk-ark-1234');
  });

  it('不存在的模型抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.updateModel({ model: 'missing', enabled: true }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.testModel({ model: 'missing' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
