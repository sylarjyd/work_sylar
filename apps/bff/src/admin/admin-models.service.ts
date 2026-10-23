import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminModelDto,
  AdminModelProviderDto,
  AdminModelsDto,
  AdminModelTestResultDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { decryptSecret, encryptSecret } from '../secrets/secret-box';
import { DEFAULT_MODEL_SETTING_KEY, MODEL_ENC_KEY } from '../models/model.constants';
import { listEnvProviderGroups } from '../models/env-providers';

const MAX_INT32 = 2_147_483_647;
const TEST_TIMEOUT_MS = 10_000;

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

function baseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_base_url');
  const value = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new BadRequestException('invalid_base_url');
  }
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
    const url = baseUrl(body?.baseUrl);
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
    if (body?.baseUrl !== undefined) data.baseUrl = baseUrl(body.baseUrl);
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
            sortOrder: order,
            ...price,
          },
          include: { provider: { select: { id: true, name: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'model.create',
          targetType: 'modelConfig',
          targetId: model,
          summary: { providerId, enabled: isEnabled, ...price },
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
      sortOrder?: number;
      inputMilliCreditsPer1k?: number;
      outputMilliCreditsPer1k?: number;
    } = {};
    if (body?.displayName !== undefined) data.displayName = optionalText(body.displayName, 128);
    if (body?.providerId !== undefined) {
      data.providerId = text(body.providerId, 'provider_required', 64);
    }
    if (body?.enabled !== undefined) data.enabled = enabled(body.enabled);
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
              sortOrder: before.sortOrder,
              input: before.inputMilliCreditsPer1k,
              output: before.outputMilliCreditsPer1k,
            },
            after: {
              displayName: updated.displayName,
              providerId: updated.providerId,
              enabled: updated.enabled,
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
    if (!row || !row.enabled) throw new BadRequestException('invalid_default_model');
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

    let key: string;
    try {
      key = decryptSecret(row.provider.apiKeyEnc, MODEL_ENC_KEY);
    } catch {
      this.logger.error(`模型 ${model} 的厂商密钥无法解密`);
      throw new ServiceUnavailableException('model_provider_unavailable');
    }

    const started = Date.now();
    let ok = false;
    let error: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(`${row.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
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
