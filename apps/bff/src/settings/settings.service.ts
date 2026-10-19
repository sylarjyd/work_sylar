import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminSettingDto, RunConfig, SettingSource } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

export interface SettingSpec {
  min: number;
  max: number;
  fallback: number;
  env?: string;
}

export const SETTING_SPECS: Record<string, SettingSpec> = {
  maxRounds: { min: 1, max: 32, fallback: 8 },
  confirmTimeoutMs: { min: 1000, max: 600000, fallback: 120000, env: 'CONFIRM_TIMEOUT_MS' },
  codeExecTimeoutMs: { min: 100, max: 60000, fallback: 5000, env: 'CODE_EXEC_TIMEOUT_MS' },
  kbChunkSize: { min: 100, max: 4000, fallback: 800, env: 'KB_CHUNK_SIZE' },
  kbChunkOverlap: { min: 0, max: 1000, fallback: 150, env: 'KB_CHUNK_OVERLAP' },
};

export type SettingKey = keyof typeof SETTING_SPECS;

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_SPECS, value);
}

interface Resolved {
  value: number;
  source: SettingSource;
  updatedAt: Date | null;
  updatedBy: string | null;
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
      this.resolve('maxRounds'),
      this.resolve('confirmTimeoutMs'),
      this.resolve('codeExecTimeoutMs'),
    ]);
    return {
      maxRounds: maxRounds.value,
      confirmTimeoutMs: confirmTimeoutMs.value,
      codeExecTimeoutMs: codeExecTimeoutMs.value,
    };
  }

  async getKbConfig(): Promise<{ chunkSize: number; chunkOverlap: number }> {
    const size = await this.resolve('kbChunkSize');
    const overlap = await this.resolve('kbChunkOverlap');
    // 脏 env 与 DB 组合也可能出现 overlap ≥ size；回落到默认 overlap 并保证小于 size。
    const chunkOverlap =
      overlap.value < size.value
        ? overlap.value
        : Math.min(SETTING_SPECS.kbChunkOverlap.fallback, Math.max(0, size.value - 1));
    return { chunkSize: size.value, chunkOverlap };
  }

  async update(key: string, raw: unknown, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    const value = this.validate(key, raw);

    if (key === 'kbChunkOverlap') {
      const size = await this.resolve('kbChunkSize');
      if (value >= size.value) throw new BadRequestException('invalid_kbChunkOverlap');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key },
        create: { key, value, updatedBy: actor.id },
        update: { value, updatedBy: actor.id },
      });
      await this.audit.write(tx, actor, {
        action: 'setting.update',
        targetType: 'setting',
        targetId: key,
        summary: { value },
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

  private validate(key: SettingKey, raw: unknown): number {
    const spec = SETTING_SPECS[key];
    if (
      typeof raw !== 'number' ||
      !Number.isSafeInteger(raw) ||
      raw < spec.min ||
      raw > spec.max
    ) {
      throw new BadRequestException('invalid_value');
    }
    return raw;
  }

  private async resolve(key: SettingKey): Promise<Resolved> {
    const spec = SETTING_SPECS[key];
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (
      row &&
      typeof row.value === 'number' &&
      Number.isSafeInteger(row.value) &&
      row.value >= spec.min &&
      row.value <= spec.max
    ) {
      return {
        value: row.value,
        source: 'db',
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    }

    if (spec.env) {
      const envValue = Number(process.env[spec.env]);
      if (Number.isSafeInteger(envValue) && envValue >= spec.min && envValue <= spec.max) {
        return { value: envValue, source: 'env', updatedAt: null, updatedBy: null };
      }
    }

    return { value: spec.fallback, source: 'default', updatedAt: null, updatedBy: null };
  }

  private async toDto(key: SettingKey): Promise<AdminSettingDto> {
    const resolved = await this.resolve(key);
    const spec = SETTING_SPECS[key];
    return {
      key,
      value: resolved.value,
      source: resolved.source,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedBy: resolved.updatedBy,
      min: spec.min,
      max: spec.max,
    };
  }
}
