import { Injectable, Logger } from '@nestjs/common';
import {
  normalizeCapabilities,
  normalizeModalities,
  type ClientModelDto,
  type ClientModelsDto,
  type ModelModality,
  type RunModelRoute,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { BillingService } from '../billing/billing.service';
import { decryptSecret } from '../secrets/secret-box';
import { DEFAULT_MODEL_SETTING_KEY, MODEL_ENC_KEY } from './model.constants';
import { resolveEnvModelProviders } from './env-providers';
import { isStoredProviderUrlAllowed } from './provider-url';
import {
  ModelPlanExpiredError,
  ModelProviderUnavailableError,
  ModelUnavailableError,
  NoModelsAvailableError,
} from './model.errors';

type ModelSource =
  | { kind: 'db'; providerId: string; baseUrl: string; apiKeyEnc: string }
  | { kind: 'env'; baseUrl: string; apiKey: string }
  | { kind: 'mock' };

export interface AvailableModel {
  model: string;
  displayName: string;
  providerName: string;
  modalities: ModelModality[];
  sortOrder: number;
  source: ModelSource;
}

export interface AvailableModels {
  models: AvailableModel[];
  defaultModel: string | null;
}

export interface RunModelResolution {
  selectedModel: string;
  /** 选中模型的输入模态，用于发消息前校验附件是否被该模型支持。 */
  selectedModalities: ModelModality[];
  modelRoutes: RunModelRoute[];
}

/**
 * 模型目录：把「全局启用模型」与「当前套餐 allowedModels」取交集。
 * 运营端已配置任何厂商时完全以数据库为准；否则回退环境变量，兼容存量部署。
 */
@Injectable()
export class ModelCatalogService {
  private readonly logger = new Logger(ModelCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async available(tenantId: string): Promise<AvailableModels> {
    const { plan, sub } = await this.billing.ensureSubscription(tenantId);
    if (sub.status !== 'active' || sub.periodEnd.getTime() <= Date.now()) {
      throw new ModelPlanExpiredError();
    }
    const providerCount = await this.prisma.modelProvider.count();
    const models =
      providerCount > 0 ? await this.loadDb(plan.allowedModels) : this.loadEnv(plan.allowedModels);
    const stored = await this.readDefaultModel();
    const defaultModel =
      stored && models.some((m) => m.model === stored) ? stored : (models[0]?.model ?? null);
    return { models, defaultModel };
  }

  /** 客户端可见列表：绝不包含 baseUrl、密钥、providerId。 */
  async listForClient(tenantId: string): Promise<ClientModelsDto> {
    const { models, defaultModel } = await this.available(tenantId);
    const out: ClientModelDto[] = models.map((m) => ({
      model: m.model,
      displayName: m.displayName,
      providerName: m.providerName,
      modalities: m.modalities,
    }));
    return { models: out, defaultModel };
  }

  /**
   * 运行前解析：校验会话模型仍然可用，解密所有可用厂商的 Key，
   * 并把选中模型排到路由第一位，供 runtime 回退时按运营端排序尝试。
   */
  async resolveForRun(tenantId: string, sessionModel: string | null): Promise<RunModelResolution> {
    const { models, defaultModel } = await this.available(tenantId);
    if (models.length === 0) throw new NoModelsAvailableError();
    const selected = sessionModel ?? defaultModel ?? models[0].model;
    const selectedEntry = models.find((m) => m.model === selected);
    if (!selectedEntry) throw new ModelUnavailableError();

    const ordered = [selectedEntry, ...models.filter((m) => m.model !== selected)];
    const routes: RunModelRoute[] = [];
    const keyCache = new Map<string, string>();
    // 同一厂商的密钥只需失败一次：其余回退模型直接跳过，避免重复解密与日志噪声。
    const failedProviders = new Set<string>();
    const blockedProviders = new Set<string>();
    for (const entry of ordered) {
      if (entry.source.kind === 'mock') continue;
      if (entry.source.kind === 'env') {
        if (!this.ensureUrlAllowed(entry.model, entry.source.baseUrl, selected)) continue;
        routes.push({
          model: entry.model,
          baseUrl: entry.source.baseUrl,
          apiKey: entry.source.apiKey,
          modalities: entry.modalities,
        });
        continue;
      }
      const { providerId } = entry.source;
      if (blockedProviders.has(providerId)) continue;
      // 运行期做同步复核：库里的地址本应在写入时通过校验，防止被直接改库后绕过。
      if (!this.ensureUrlAllowed(entry.model, entry.source.baseUrl, selected)) {
        blockedProviders.add(providerId);
        continue;
      }
      if (failedProviders.has(providerId)) continue;
      try {
        let apiKey = keyCache.get(providerId);
        if (apiKey === undefined) {
          apiKey = decryptSecret(entry.source.apiKeyEnc, MODEL_ENC_KEY);
          keyCache.set(providerId, apiKey);
        }
        routes.push({
          model: entry.model,
          baseUrl: entry.source.baseUrl,
          apiKey,
          modalities: entry.modalities,
        });
      } catch {
        // 单把密钥损坏只影响该厂商；选中的模型不可用时整体失败，避免静默换厂商。
        failedProviders.add(providerId);
        if (entry.model === selected) {
          this.logger.error(`模型 ${selected} 的厂商密钥无法解密`);
          throw new ModelProviderUnavailableError();
        }
        this.logger.warn(`跳过厂商 ${providerId} 的模型 ${entry.model}：密钥无法解密`);
      }
    }
    return {
      selectedModel: selected,
      selectedModalities: selectedEntry.modalities,
      modelRoutes: routes,
    };
  }

  /** 地址被安全策略拒绝时跳过该模型；选中的模型不可用则整体失败，避免静默换厂商。 */
  private ensureUrlAllowed(model: string, baseUrl: string, selected: string): boolean {
    if (isStoredProviderUrlAllowed(baseUrl)) return true;
    this.logger.warn(`跳过模型 ${model}：厂商地址命中安全策略`);
    if (model === selected) throw new ModelProviderUnavailableError();
    return false;
  }

  private async loadDb(allowed: string[]): Promise<AvailableModel[]> {
    const rows = await this.prisma.modelConfig.findMany({
      where: { enabled: true, providerId: { not: null } },
      include: { provider: true },
      orderBy: [{ sortOrder: 'asc' }, { model: 'asc' }],
    });
    return rows.flatMap((row) => {
      const provider = row.provider;
      if (!provider || !allowed.includes(row.model)) return [];
      // 只有对话模型进入聊天目录；存量行缺 capabilities 时按 chat 处理。
      const caps = normalizeCapabilities(row.capabilities);
      if (caps.length > 0 && !caps.includes('chat')) return [];
      return [
        {
          model: row.model,
          displayName: row.displayName ?? row.model,
          providerName: provider.name,
          modalities: normalizeModalities(row.modalities),
          sortOrder: row.sortOrder,
          source: {
            kind: 'db' as const,
            providerId: provider.id,
            baseUrl: provider.baseUrl,
            apiKeyEnc: provider.apiKeyEnc,
          },
        },
      ];
    });
  }

  private loadEnv(allowed: string[]): AvailableModel[] {
    // 与 runtime 相同的回退顺序：有密钥的 MODEL_PROVIDERS → DEEPSEEK_API_KEY。
    const resolved = resolveEnvModelProviders(process.env);
    if (resolved.length === 0) {
      // 完全没有密钥：runtime 会回退 MockGateway，仍展示套餐模型供本地/CI 验证链路。
      return allowed.map((model) => ({
        model,
        displayName: model,
        providerName: '环境变量',
        modalities: ['text' as const],
        sortOrder: 0,
        source: { kind: 'mock' as const },
      }));
    }
    const configured = resolved.filter((p) => allowed.includes(p.model));
    if (configured.length === 0) {
      // 配了模型但都不在套餐内：不能伪装成 Mock，否则展示与运行（model_not_allowed
      // 或越权调用静态网关模型）不一致。返回空集，由调用方给出明确的业务错误。
      this.logger.warn('环境变量模型与当前套餐无交集，未提供可用模型');
      return [];
    }
    return configured.map((p) => ({
      model: p.model,
      displayName: p.model,
      providerName: '环境变量',
      modalities: p.modalities,
      sortOrder: 0,
      source: { kind: 'env' as const, baseUrl: p.baseUrl, apiKey: p.apiKey },
    }));
  }

  private async readDefaultModel(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({
      where: { key: DEFAULT_MODEL_SETTING_KEY },
    });
    return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
  }
}
