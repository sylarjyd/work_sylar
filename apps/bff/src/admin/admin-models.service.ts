import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MODEL_CAPABILITIES,
  MODEL_MODALITIES,
  normalizeCapabilities,
  normalizeModalities,
  type AdminModelDto,
  type AdminModelProviderDto,
  type AdminModelsDto,
  type AdminModelTestResultDto,
  type AdminProviderModelsDto,
  type ModelCapability,
  type ModelModality,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { decryptSecret, encryptSecret } from '../secrets/secret-box';
import { DEFAULT_MODEL_SETTING_KEY, MODEL_ENC_KEY } from '../models/model.constants';
import { listEnvProviderGroups } from '../models/env-providers';
import {
  validateProviderBaseUrl,
  type ProviderUrlOptions,
} from '../models/provider-url';

const MAX_INT32 = 2_147_483_647;
const TEST_TIMEOUT_MS = 10_000;
/** /models 响应上限：正常厂商几百个模型也就几十 KB，超过视为异常响应。 */
const MODELS_MAX_BYTES = 2 * 1024 * 1024;
const MODELS_MAX_COUNT = 500;

/** 兼容 OpenAI（data[].id）、数组字符串与 Ollama（models[].name）三种 /models 形态。 */
function extractModelIds(value: unknown): string[] {
  const out = new Set<string>();
  const push = (item: unknown): void => {
    if (typeof item === 'string' && item.trim()) out.add(item.trim());
  };
  if (value !== null && typeof value === 'object') {
    const data = (value as { data?: unknown }).data;
    const models = (value as { models?: unknown }).models;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'object' && item !== null) push((item as { id?: unknown }).id);
        else push(item);
      }
    }
    if (Array.isArray(models)) {
      for (const item of models) {
        if (typeof item === 'object' && item !== null) {
          push((item as { name?: unknown }).name ?? (item as { id?: unknown }).id);
        } else push(item);
      }
    }
  }
  return [...out].sort().slice(0, MODELS_MAX_COUNT);
}

interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string | null;
  createdAt: Date;
  _count: { models: number };
}

interface ModelRow {
  model: string;
  displayName: string | null;
  providerId: string | null;
  enabled: boolean;
  capabilities: string[];
  modalities: string[];
  sortOrder: number;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  updatedAt: Date;
  provider: { id: string; name: string } | null;
}

function text(raw: unknown, code: string, maxLength: number): string {
  if (typeof raw !== 'string') throw new BadRequestException(code);
  const value = raw.trim();
  if (value === '' || value.length > maxLength) throw new BadRequestException(code);
  return value;
}

function optionalText(raw: unknown, maxLength: number): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException('invalid_display_name');
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > maxLength) throw new BadRequestException('invalid_display_name');
  return value;
}

function apiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_api_key');
  const value = raw.trim();
  if (value === '' || value.length > 512) throw new BadRequestException('invalid_api_key');
  return value;
}

function enabled(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new BadRequestException('invalid_enabled');
  return raw;
}

function sortOrder(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > 1_000_000) {
    throw new BadRequestException('invalid_sort_order');
  }
  return raw;
}

function priceInt(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_INT32) {
    throw new BadRequestException('invalid_price');
  }
  return raw;
}

function prices(raw: unknown): {
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
} {
  if (raw === null || typeof raw !== 'object') throw new BadRequestException('invalid_price');
  const p = raw as Record<string, unknown>;
  return {
    inputMilliCreditsPer1k: priceInt(p.inputMilliCreditsPer1k),
    outputMilliCreditsPer1k: priceInt(p.outputMilliCreditsPer1k),
  };
}

function modelName(raw: unknown): string {
  return text(raw, 'invalid_model', 128);
}

/** 能力分类至少选一项；未知值或非字符串一律拒绝，避免脏数据进入目录。 */
function capabilities(raw: unknown): ModelCapability[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException('invalid_capabilities');
  }
  for (const item of raw) {
    if (typeof item !== 'string' || !MODEL_CAPABILITIES.includes(item as ModelCapability)) {
      throw new BadRequestException('invalid_capabilities');
    }
  }
  return normalizeCapabilities(raw as string[]);
}

/** 存量行没有 capabilities 时按对话模型处理，与旧版行为一致。 */
function rowCapabilities(raw: string[] | null | undefined): ModelCapability[] {
  const out = normalizeCapabilities(raw);
  return out.length > 0 ? out : ['chat'];
}

/** 模态至少选一项；未知值或非字符串一律拒绝，避免脏数据进入目录。 */
function modalities(raw: unknown): ModelModality[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException('invalid_modalities');
  }
  for (const item of raw) {
    if (typeof item !== 'string' || !MODEL_MODALITIES.includes(item as ModelModality)) {
      throw new BadRequestException('invalid_modalities');
    }
  }
  return normalizeModalities(raw as string[]);
}

function hint(secret: string): string {
  return secret.length >= 4 ? `****${secret.slice(-4)}` : '****';
}

function redact(message: string, secret: string): string {
  const clean = secret ? message.split(secret).join('[REDACTED]') : message;
  return clean.slice(0, 300);
}

function toProviderDto(row: ProviderRow): AdminModelProviderDto {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKeyHint: row.apiKeyHint,
    modelCount: row._count.models,
    createdAt: row.createdAt.toISOString(),
  };
}

function toModelDto(row: ModelRow, defaultModel: string | null): AdminModelDto {
  return {
    model: row.model,
    displayName: row.displayName ?? row.model,
    providerId: row.providerId,
    providerName: row.provider?.name ?? null,
    enabled: row.enabled,
    capabilities: rowCapabilities(row.capabilities),
    modalities: normalizeModalities(row.modalities),
    sortOrder: row.sortOrder,
    inputMilliCreditsPer1k: row.inputMilliCreditsPer1k,
    outputMilliCreditsPer1k: row.outputMilliCreditsPer1k,
    isDefault: defaultModel === row.model,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 运营端模型目录：厂商、模型、默认模型与连通性测试；所有写操作与审计同事务。 */
@Injectable()
export class AdminModelsService {
  private readonly logger = new Logger(AdminModelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // 测试可注入 DNS 解析器与环境变量；生产由 Nest 注入 undefined，走默认实现。
    @Optional() private readonly urlOptions?: ProviderUrlOptions,
  ) {}

  async catalog(): Promise<AdminModelsDto> {
    const [providers, models, defaultModel] = await Promise.all([
      this.prisma.modelProvider.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { models: true } } },
      }),
      this.prisma.modelConfig.findMany({
        orderBy: [{ sortOrder: 'asc' }, { model: 'asc' }],
        include: { provider: { select: { id: true, name: true } } },
      }),
      this.readDefault(this.prisma),
    ]);
    return {
      providers: providers.map(toProviderDto),
      models: models.map((m) => toModelDto(m, defaultModel)),
      defaultModel,
      fallback: { active: providers.length === 0, providers: listEnvProviderGroups(process.env) },
    };
  }

  async createProvider(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelProviderDto> {
    const name = text(body?.name, 'invalid_provider_name', 64);
    const url = await validateProviderBaseUrl(body?.baseUrl, this.urlOptions);
    const plain = apiKey(body?.apiKey);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelProvider.create({
          data: {
            name,
            baseUrl: url,
            apiKeyEnc: encryptSecret(plain, MODEL_ENC_KEY),
            apiKeyHint: hint(plain),
          },
          include: { _count: { select: { models: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'modelProvider.create',
          targetType: 'modelProvider',
          targetId: created.id,
          summary: { name },
        });
        return created;
      });
      return toProviderDto(row);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('provider_exists');
      }
      throw err;
    }
  }

  async updateProvider(
    id: string,
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelProviderDto> {
    const providerId = text(id, 'invalid_provider_id', 64);
    const data: { name?: string; baseUrl?: string; apiKeyEnc?: string; apiKeyHint?: string } = {};
    if (body?.name !== undefined) data.name = text(body.name, 'invalid_provider_name', 64);
    if (body?.baseUrl !== undefined) {
      data.baseUrl = await validateProviderBaseUrl(body.baseUrl, this.urlOptions);
    }
    if (body?.apiKey !== undefined) {
      const plain = apiKey(body.apiKey);
      data.apiKeyEnc = encryptSecret(plain, MODEL_ENC_KEY);
      data.apiKeyHint = hint(plain);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_provider_patch');

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelProvider.findUnique({ where: { id: providerId } });
        if (!before) throw new NotFoundException('provider_not_found');
        const updated = await tx.modelProvider.update({
          where: { id: providerId },
          data,
          include: { _count: { select: { models: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'modelProvider.update',
          targetType: 'modelProvider',
          targetId: providerId,
          summary: {
            before: { name: before.name, baseUrl: before.baseUrl },
            after: { name: updated.name, baseUrl: updated.baseUrl },
          },
        });
        return updated;
      });
      return toProviderDto(row);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictException('provider_exists');
      if (code === 'P2025') throw new NotFoundException('provider_not_found');
      throw err;
    }
  }

  /**
   * 探测厂商 /models：新建时用表单里的 baseUrl + API Key，编辑时用库里已存的密钥。
   * 请求只发生在服务端（API Key 不落地浏览器），结果归一为模型名数组供前端勾选。
   */
  async providerModels(body: unknown, actor: AdminActor): Promise<AdminProviderModelsDto> {
    const input = (body ?? {}) as Record<string, unknown>;
    const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
    let baseUrl: string;
    let key: string;
    if (providerId) {
      const row = await this.prisma.modelProvider.findUnique({
        where: { id: providerId },
        select: { baseUrl: true, apiKeyEnc: true },
      });
      if (!row) throw new NotFoundException('provider_not_found');
      try {
        key = decryptSecret(row.apiKeyEnc, MODEL_ENC_KEY);
      } catch {
        this.logger.error(`厂商 ${providerId} 的密钥无法解密`);
        throw new ServiceUnavailableException('model_provider_unavailable');
      }
      baseUrl = await validateProviderBaseUrl(row.baseUrl, this.urlOptions);
    } else {
      const rawBaseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
      const rawKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      if (!rawBaseUrl || !rawKey) throw new BadRequestException('invalid_provider');
      baseUrl = await validateProviderBaseUrl(rawBaseUrl, this.urlOptions);
      key = rawKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: controller.signal,
          // 厂商地址由管理员配置，但不允许被上游重定向到别的主机。
          redirect: 'error',
        });
      } catch (err) {
        const aborted = (err as Error).name === 'AbortError';
        throw new BadGatewayException(aborted ? 'provider_timeout' : 'provider_unreachable');
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new BadGatewayException('provider_unauthorized');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new BadGatewayException(`provider_http_${res.status}`);
      }
      const text = await res.text().catch(() => '');
      if (!text || text.length > MODELS_MAX_BYTES) {
        throw new BadGatewayException('invalid_models_response');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new BadGatewayException('invalid_models_response');
      }
      const models = extractModelIds(parsed);
      if (models.length === 0) throw new BadGatewayException('invalid_models_response');

      await this.audit.bestEffort(actor, {
        action: 'modelProvider.probeModels',
        targetType: 'modelProvider',
        targetId: providerId || undefined,
        summary: { count: models.length },
      });
      return { models };
    } finally {
      clearTimeout(timer);
    }
  }

  async removeProvider(id: string, actor: AdminActor): Promise<void> {
    const providerId = text(id, 'invalid_provider_id', 64);
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelProvider.findUnique({ where: { id: providerId } });
        if (!before) throw new NotFoundException('provider_not_found');
        const count = await tx.modelConfig.count({ where: { providerId } });
        if (count > 0) throw new BadRequestException('provider_has_models');
        await tx.modelProvider.delete({ where: { id: providerId } });
        await this.audit.write(tx, actor, {
          action: 'modelProvider.delete',
          targetType: 'modelProvider',
          targetId: providerId,
          summary: { name: before.name },
        });
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') throw new NotFoundException('provider_not_found');
      if (code === 'P2003') throw new BadRequestException('provider_has_models');
      throw err;
    }
  }

  async createModel(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelDto> {
    const model = modelName(body?.model);
    const providerId = text(body?.providerId, 'provider_required', 64);
    const displayName = optionalText(body?.displayName, 128);
    const isEnabled = body?.enabled === undefined ? false : enabled(body.enabled);
    // 未携带分类/模态时按对话 + 纯文本处理，兼容旧版管理端与脚本调用。
    const modelCapabilities: ModelCapability[] =
      body?.capabilities === undefined ? ['chat'] : capabilities(body.capabilities);
    const modelModalities: ModelModality[] =
      body?.modalities === undefined ? ['text'] : modalities(body.modalities);
    const order = body?.sortOrder === undefined ? 0 : sortOrder(body.sortOrder);
    const price = prices(body?.prices);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelConfig.create({
          data: {
            model,
            providerId,
            displayName,
            enabled: isEnabled,
            capabilities: modelCapabilities,
            modalities: modelModalities,
            sortOrder: order,
            ...price,
          },
          include: { provider: { select: { id: true, name: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'model.create',
          targetType: 'modelConfig',
          targetId: model,
          summary: {
            providerId,
            enabled: isEnabled,
            capabilities: modelCapabilities,
            modalities: modelModalities,
            ...price,
          },
        });
        return created;
      });
      return toModelDto(row, await this.readDefault(this.prisma));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictException('model_exists');
      if (code === 'P2003') throw new NotFoundException('provider_not_found');
      throw err;
    }
  }

  async updateModel(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelDto> {
    const model = modelName(body?.model);
    const data: {
      displayName?: string | null;
      providerId?: string;
      enabled?: boolean;
      capabilities?: ModelCapability[];
      modalities?: ModelModality[];
      sortOrder?: number;
      inputMilliCreditsPer1k?: number;
      outputMilliCreditsPer1k?: number;
    } = {};
    if (body?.displayName !== undefined) data.displayName = optionalText(body.displayName, 128);
    if (body?.providerId !== undefined) {
      data.providerId = text(body.providerId, 'provider_required', 64);
    }
    if (body?.enabled !== undefined) data.enabled = enabled(body.enabled);
    if (body?.capabilities !== undefined) {
      data.capabilities = capabilities(body.capabilities);
    }
    if (body?.modalities !== undefined) data.modalities = modalities(body.modalities);
    if (body?.sortOrder !== undefined) data.sortOrder = sortOrder(body.sortOrder);
    if (body?.prices !== undefined) Object.assign(data, prices(body.prices));
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_model_patch');

    const defaultModel = await this.readDefault(this.prisma);
    if (data.enabled === false && defaultModel === model) {
      throw new BadRequestException('default_model_in_use');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelConfig.findUnique({ where: { model } });
        if (!before) throw new NotFoundException('model_not_found');
        const updated = await tx.modelConfig.update({
          where: { model },
          data,
          include: { provider: { select: { id: true, name: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'model.update',
          targetType: 'modelConfig',
          targetId: model,
          summary: {
            before: {
              displayName: before.displayName,
              providerId: before.providerId,
              enabled: before.enabled,
              capabilities: rowCapabilities(before.capabilities),
              modalities: normalizeModalities(before.modalities),
              sortOrder: before.sortOrder,
              input: before.inputMilliCreditsPer1k,
              output: before.outputMilliCreditsPer1k,
            },
            after: {
              displayName: updated.displayName,
              providerId: updated.providerId,
              enabled: updated.enabled,
              capabilities: rowCapabilities(updated.capabilities),
              modalities: normalizeModalities(updated.modalities),
              sortOrder: updated.sortOrder,
              input: updated.inputMilliCreditsPer1k,
              output: updated.outputMilliCreditsPer1k,
            },
          },
        });
        return updated;
      });
      return toModelDto(row, defaultModel);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') throw new NotFoundException('model_not_found');
      if (code === 'P2003') throw new NotFoundException('provider_not_found');
      throw err;
    }
  }

  async removeModel(model: string, actor: AdminActor): Promise<void> {
    const name = modelName(model);
    try {
      await this.prisma.$transaction(async (tx) => {
        // 锁住价格行，避免套餐在引用校验与删除之间插入。
        const locked = await tx.$queryRaw<Array<{ model: string }>>`
          SELECT "model" FROM "ModelPrice" WHERE "model" = ${name} FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundException('model_not_found');

        const defaultModel = await this.readDefault(tx);
        if (defaultModel === name) throw new BadRequestException('default_model_in_use');

        const used = await tx.plan.findFirst({
          where: { active: true, allowedModels: { has: name } },
          select: { id: true },
        });
        if (used) throw new BadRequestException('model_in_use');

        // 停用套餐的有效订阅仍可使用到期，同样不能删。
        const subscribed = await tx.subscription.findFirst({
          where: { periodEnd: { gt: new Date() }, plan: { allowedModels: { has: name } } },
          select: { tenantId: true },
        });
        if (subscribed) throw new BadRequestException('model_in_use');

        await tx.modelConfig.delete({ where: { model: name } });
        await this.audit.write(tx, actor, {
          action: 'model.delete',
          targetType: 'modelConfig',
          targetId: name,
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('model_not_found');
      }
      throw err;
    }
  }

  async setDefault(body: Record<string, unknown>, actor: AdminActor): Promise<AdminModelsDto> {
    const model = modelName(body?.model);
    const row = await this.prisma.modelConfig.findUnique({ where: { model } });
    // 默认模型用于对话；Embedding/Rerank/TTS/ASR 设为默认会让新会话直接不可用。
    if (!row || !row.enabled || !rowCapabilities(row.capabilities).includes('chat')) {
      throw new BadRequestException('invalid_default_model');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: DEFAULT_MODEL_SETTING_KEY },
        create: { key: DEFAULT_MODEL_SETTING_KEY, value: model, updatedBy: actor.id },
        update: { value: model, updatedBy: actor.id },
      });
      await this.audit.write(tx, actor, {
        action: 'model.default',
        targetType: 'modelConfig',
        targetId: model,
      });
    });
    return this.catalog();
  }

  /**
   * 测试连接：只发一次最小补全请求，失败也返回 200 结果体。
   * 上游错误可能回显请求头，返回前必须把 Key 替换掉并截断。
   */
  async testModel(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelTestResultDto> {
    const model = modelName(body?.model);
    const row = await this.prisma.modelConfig.findUnique({
      where: { model },
      include: { provider: true },
    });
    if (!row || !row.provider) throw new NotFoundException('model_not_found');
    // 连通性测试固定走 /chat/completions；非对话模型（Embedding/Rerank/TTS/ASR）
    // 的探测方式各不相同，先明确拒绝而不是给出误导性的失败结果。
    if (!rowCapabilities(row.capabilities).includes('chat')) {
      throw new BadRequestException('model_test_unsupported');
    }

    let key: string;
    try {
      key = decryptSecret(row.provider.apiKeyEnc, MODEL_ENC_KEY);
    } catch {
      this.logger.error(`模型 ${model} 的厂商密钥无法解密`);
      throw new ServiceUnavailableException('model_provider_unavailable');
    }

    // 写入时已校验，这里再复核一次：配置可能被直接改库，或安全策略后来收紧。
    const baseUrl = await validateProviderBaseUrl(row.provider.baseUrl, this.urlOptions);
    const started = Date.now();
    let ok = false;
    let error: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
        // 厂商地址由管理员配置（可能指向内网部署），但不允许再被上游重定向到其他主机。
        redirect: 'error',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        error = redact(`HTTP ${res.status} ${text}`.trim(), key);
      } else {
        await res.body?.cancel().catch(() => undefined);
        ok = true;
      }
    } catch (err) {
      const name = (err as Error).name;
      error = redact(name === 'AbortError' ? 'timeout' : (err as Error).message, key);
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    await this.audit.bestEffort(actor, {
      action: 'model.test',
      targetType: 'modelConfig',
      targetId: model,
      summary: { ok, latencyMs },
    });
    return { ok, latencyMs, ...(error ? { error } : {}) };
  }

  private async readDefault(
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await client.setting.findUnique({
      where: { key: DEFAULT_MODEL_SETTING_KEY },
    });
    return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
  }
}
