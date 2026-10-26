import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminSettingDto,
  AdminSettingValue,
  RunConfig,
  SettingSource,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

export interface NumberSettingSpec {
  type: 'number';
  min: number;
  max: number;
  fallback: number;
  env?: string;
}

export interface StringSettingSpec {
  type: 'string';
  fallback: string;
  maxLength: number;
  env?: string;
  validate?: (value: string) => boolean;
}

export interface BooleanSettingSpec {
  type: 'boolean';
  fallback: boolean;
  env?: string;
}

export interface SecretSettingSpec {
  type: 'secret';
  fallback: string;
  maxLength: number;
  env?: string;
}

export type SettingSpec =
  | NumberSettingSpec
  | StringSettingSpec
  | BooleanSettingSpec
  | SecretSettingSpec;

/** 空串是合法值（表示停用 Webhook）；非空时只允许 http/https，防止 SSRF 到 file 等协议。 */
function isHttpUrlOrEmpty(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const SETTING_SPECS = {
  maxRounds: { type: 'number', min: 1, max: 32, fallback: 8 },
  confirmTimeoutMs: { type: 'number', min: 1000, max: 600000, fallback: 120000, env: 'CONFIRM_TIMEOUT_MS' },
  codeExecTimeoutMs: { type: 'number', min: 100, max: 60000, fallback: 5000, env: 'CODE_EXEC_TIMEOUT_MS' },
  kbChunkSize: { type: 'number', min: 100, max: 4000, fallback: 800, env: 'KB_CHUNK_SIZE' },
  kbChunkOverlap: { type: 'number', min: 0, max: 1000, fallback: 150, env: 'KB_CHUNK_OVERLAP' },
  queueMaxAttempts: { type: 'number', min: 0, max: 5, fallback: 2, env: 'RUN_QUEUE_MAX_ATTEMPTS' },
  queuePerTenantConcurrency: {
    type: 'number',
    min: 1,
    max: 8,
    fallback: 2,
    env: 'RUN_QUEUE_PER_TENANT',
  },
  queueMaxPerTenant: { type: 'number', min: 1, max: 200, fallback: 50, env: 'RUN_QUEUE_MAX_PER_TENANT' },
  alertsEnabled: { type: 'boolean', fallback: true, env: 'ALERTS_ENABLED' },
  alertWebhookUrl: {
    type: 'string',
    fallback: '',
    maxLength: 2048,
    env: 'ALERT_WEBHOOK_URL',
    validate: isHttpUrlOrEmpty,
  },
  alertWebhookSecret: {
    type: 'secret',
    fallback: '',
    maxLength: 256,
    env: 'ALERT_WEBHOOK_SECRET',
  },
} satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTING_SPECS;

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_SPECS, value);
}

interface Resolved {
  value: AdminSettingValue;
  source: SettingSource;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** 只暴露尾部 4 位，短密钥连长度都不透露。 */
function maskSecret(value: string): string {
  if (value === '') return '';
  return value.length >= 8 ? `****${value.slice(-4)}` : '****';
}

/** 管理端参数配置：DB 覆盖 → env → 默认值的优先级解析，写操作与审计同事务。 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getAll(): Promise<AdminSettingDto[]> {
    return Promise.all((Object.keys(SETTING_SPECS) as SettingKey[]).map((key) => this.toDto(key)));
  }

  async getRunConfig(): Promise<Required<RunConfig>> {
    const [maxRounds, confirmTimeoutMs, codeExecTimeoutMs] = await Promise.all([
      this.resolveNumber('maxRounds'),
      this.resolveNumber('confirmTimeoutMs'),
      this.resolveNumber('codeExecTimeoutMs'),
    ]);
    return { maxRounds, confirmTimeoutMs, codeExecTimeoutMs };
  }

  async getKbConfig(): Promise<{ chunkSize: number; chunkOverlap: number }> {
    const [size, overlap] = await Promise.all([
      this.resolveNumber('kbChunkSize'),
      this.resolveNumber('kbChunkOverlap'),
    ]);
    // 脏 env 与 DB 组合也可能出现 overlap ≥ size；回落到默认 overlap 并保证小于 size。
    const chunkOverlap =
      overlap < size
        ? overlap
        : Math.min(SETTING_SPECS.kbChunkOverlap.fallback, Math.max(0, size - 1));
    return { chunkSize: size, chunkOverlap };
  }

  /** 任务队列读取生效参数：最大尝试次数、单租户并发与单租户排队上限。 */
  async getQueueConfig(): Promise<{
    maxAttempts: number;
    perTenantConcurrency: number;
    maxPerTenant: number;
  }> {
    const [maxAttempts, perTenantConcurrency, maxPerTenant] = await Promise.all([
      this.resolveNumber('queueMaxAttempts'),
      this.resolveNumber('queuePerTenantConcurrency'),
      this.resolveNumber('queueMaxPerTenant'),
    ]);
    return { maxAttempts, perTenantConcurrency, maxPerTenant };
  }

  /** 告警任务读取生效配置；secret 仅在此处解密后的进程内使用，不进入日志。 */
  async getAlertSettings(): Promise<{
    enabled: boolean;
    webhookUrl: string;
    webhookSecret: string;
  }> {
    const [enabled, url, secret] = await Promise.all([
      this.resolve('alertsEnabled'),
      this.resolve('alertWebhookUrl'),
      this.resolve('alertWebhookSecret'),
    ]);
    return {
      enabled: enabled.value as boolean,
      webhookUrl: url.value as string,
      webhookSecret: secret.value as string,
    };
  }

  async update(key: string, raw: unknown, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    const value = this.validate(key, raw);

    if (key === 'kbChunkOverlap') {
      const size = await this.resolveNumber('kbChunkSize');
      if ((value as number) >= size) throw new BadRequestException('invalid_kbChunkOverlap');
    }

    if (key === 'kbChunkSize') {
      // 与当前生效的 overlap 联合校验，避免落库 overlap ≥ size 的不一致状态。
      const overlap = await this.resolveNumber('kbChunkOverlap');
      if (overlap >= (value as number)) throw new BadRequestException('invalid_kbChunkSize');
    }

    // secret 显式清空（null/空串）写成 DB 空串：优先级高于 env，避免“清空后被 env 复活”。
    const stored: number | string | boolean = value === null ? '' : value;
    const auditSummary =
      SETTING_SPECS[key].type === 'secret'
        ? { value: value === null || value === '' ? null : maskSecret(String(value)) }
        : { value: stored };

    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: stored, updatedBy: actor.id },
        update: { value: stored, updatedBy: actor.id },
      });
      await this.audit.write(tx, actor, {
        action: 'setting.update',
        targetType: 'setting',
        targetId: key,
        summary: auditSummary,
      });
    });
    return this.toDto(key);
  }

  async reset(key: string, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    await this.prisma.$transaction(async (tx) => {
      await tx.setting.deleteMany({ where: { key } });
      await this.audit.write(tx, actor, {
        action: 'setting.reset',
        targetType: 'setting',
        targetId: key,
      });
    });
    return this.toDto(key);
  }

  private validate(key: SettingKey, raw: unknown): AdminSettingValue {
    const spec = SETTING_SPECS[key];
    switch (spec.type) {
      case 'number':
        if (
          typeof raw !== 'number' ||
          !Number.isSafeInteger(raw) ||
          raw < spec.min ||
          raw > spec.max
        ) {
          throw new BadRequestException('invalid_value');
        }
        return raw;
      case 'boolean':
        if (typeof raw !== 'boolean') throw new BadRequestException('invalid_value');
        return raw;
      case 'string':
        if (
          typeof raw !== 'string' ||
          raw.length > spec.maxLength ||
          (spec.validate !== undefined && !spec.validate(raw))
        ) {
          throw new BadRequestException('invalid_value');
        }
        return raw;
      case 'secret':
        // null 与空串都表示显式清空；不 trim，密钥必须逐字节一致。
        if (raw === null) return null;
        if (typeof raw !== 'string' || raw.length > spec.maxLength) {
          throw new BadRequestException('invalid_value');
        }
        return raw;
    }
  }

  private async resolveNumber(key: SettingKey): Promise<number> {
    return (await this.resolve(key)).value as number;
  }

  private async resolve(key: SettingKey): Promise<Resolved> {
    const spec = SETTING_SPECS[key];
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (row) {
      const value = this.fromStored(spec, row.value);
      if (value !== undefined) {
        return {
          value,
          source: 'db',
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        };
      }
    }

    // 部分规格没有 env 字段；union 上直接取 .env 会被 tsc 拒绝。
    const envName = 'env' in spec ? spec.env : undefined;
    if (envName) {
      const value = this.fromEnv(spec, process.env[envName]);
      if (value !== undefined) {
        return { value, source: 'env', updatedAt: null, updatedBy: null };
      }
    }

    return { value: spec.fallback, source: 'default', updatedAt: null, updatedBy: null };
  }

  /** undefined 表示「该来源的值不可用，继续回落」；空串是合法值。 */
  private fromStored(spec: SettingSpec, raw: unknown): AdminSettingValue | undefined {
    switch (spec.type) {
      case 'number':
        return typeof raw === 'number' &&
          Number.isSafeInteger(raw) &&
          raw >= spec.min &&
          raw <= spec.max
          ? raw
          : undefined;
      case 'boolean':
        return typeof raw === 'boolean' ? raw : undefined;
      case 'string':
        return typeof raw === 'string' &&
          raw.length <= spec.maxLength &&
          (spec.validate === undefined || spec.validate(raw))
          ? raw
          : undefined;
      case 'secret':
        return typeof raw === 'string' && raw.length <= spec.maxLength ? raw : undefined;
    }
  }

  private fromEnv(spec: SettingSpec, raw: string | undefined): AdminSettingValue | undefined {
    // 空/空白 env 视为未设置：Number('') === 0，否则会把「清空变量」误解析为 0。
    if (raw === undefined || raw.trim() === '') return undefined;
    switch (spec.type) {
      case 'number': {
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max
          ? value
          : undefined;
      }
      case 'boolean': {
        const value = raw.trim().toLowerCase();
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
        return undefined;
      }
      case 'string':
        return raw.length <= spec.maxLength &&
          (spec.validate === undefined || spec.validate(raw))
          ? raw
          : undefined;
      case 'secret':
        return raw.length <= spec.maxLength ? raw : undefined;
    }
  }

  private async toDto(key: SettingKey): Promise<AdminSettingDto> {
    const spec = SETTING_SPECS[key];
    const resolved = await this.resolve(key);
    const base = {
      key,
      source: resolved.source,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedBy: resolved.updatedBy,
    };

    switch (spec.type) {
      case 'number':
        return { ...base, type: 'number', value: resolved.value as number, min: spec.min, max: spec.max };
      case 'boolean':
        return { ...base, type: 'boolean', value: resolved.value as boolean };
      case 'string':
        return { ...base, type: 'string', value: resolved.value as string, maxLength: spec.maxLength };
      case 'secret': {
        const value = resolved.value as string;
        return {
          ...base,
          type: 'secret',
          configured: value !== '',
          maskedValue: value === '' ? null : maskSecret(value),
          maxLength: spec.maxLength,
        };
      }
    }
  }
}
