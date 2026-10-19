import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ModelPrice } from '@prisma/client';
import type {
  AdminModelPriceDto,
  AdminModelProviderDto,
  AdminModelsDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

/** 从运行时同款环境变量解析 provider/模型清单；只暴露名字，绝不读取密钥值。 */
export function listProviders(env: NodeJS.ProcessEnv): AdminModelProviderDto[] {
  if (env.MODEL_PROVIDERS) {
    try {
      const parsed: unknown = JSON.parse(env.MODEL_PROVIDERS);
      if (Array.isArray(parsed)) {
        // 按 apiKeyEnv 归组，让管理端看到一个 provider 下的全部模型；仅保留名字，避免泄露 baseUrl/密钥。
        const groups = new Map<string, string[]>();
        for (const item of parsed) {
          if (item === null || typeof item !== 'object') continue;
          const p = item as Record<string, unknown>;
          if (typeof p.model !== 'string' || p.model === '') continue;
          const name =
            typeof p.apiKeyEnv === 'string' && p.apiKeyEnv !== '' ? p.apiKeyEnv : 'default';
          groups.set(name, [...(groups.get(name) ?? []), p.model]);
        }
        if (groups.size > 0) return [...groups].map(([name, models]) => ({ name, models }));
      }
    } catch {
      // 配置非法时管理端仍应可用，回落单模型视图。
    }
  }
  return [{ name: 'default', models: [env.MODEL_NAME ?? 'deepseek-chat'] }];
}

/** 价格必须是非负安全整数，避免浮点或溢出导致计费失真。 */
function priceInt(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new BadRequestException('invalid_price');
  }
  return raw;
}

function modelName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new BadRequestException('invalid_model');
  return raw.trim();
}

function toDto(row: ModelPrice): AdminModelPriceDto {
  return {
    model: row.model,
    inputMilliCreditsPer1k: row.inputMilliCreditsPer1k,
    outputMilliCreditsPer1k: row.outputMilliCreditsPer1k,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 管理端模型目录：当前环境解析出的 provider/模型（脱敏）与模型价格 CRUD，写操作与审计同事务。 */
@Injectable()
export class AdminModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async catalog(): Promise<AdminModelsDto> {
    const rows = await this.prisma.modelPrice.findMany({ orderBy: { model: 'asc' } });
    return { providers: listProviders(process.env), prices: rows.map(toDto) };
  }

  async create(
    body: { model?: unknown; inputMilliCreditsPer1k?: unknown; outputMilliCreditsPer1k?: unknown },
    actor: AdminActor,
  ): Promise<AdminModelPriceDto> {
    const model = modelName(body?.model);
    const input = priceInt(body?.inputMilliCreditsPer1k);
    const output = priceInt(body?.outputMilliCreditsPer1k);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelPrice.create({
          data: { model, inputMilliCreditsPer1k: input, outputMilliCreditsPer1k: output },
        });
        await this.audit.write(tx, actor, {
          action: 'modelPrice.create',
          targetType: 'modelPrice',
          targetId: model,
          summary: { input, output },
        });
        return created;
      });
      return toDto(row);
    } catch (err) {
      // 并发创建同一模型时由唯一约束兜底，避免先查后写的竞态。
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('model_exists');
      }
      throw err;
    }
  }

  async update(
    model: string,
    body: { inputMilliCreditsPer1k?: unknown; outputMilliCreditsPer1k?: unknown },
    actor: AdminActor,
  ): Promise<AdminModelPriceDto> {
    const data: { inputMilliCreditsPer1k?: number; outputMilliCreditsPer1k?: number } = {};
    if (body?.inputMilliCreditsPer1k !== undefined) {
      data.inputMilliCreditsPer1k = priceInt(body.inputMilliCreditsPer1k);
    }
    if (body?.outputMilliCreditsPer1k !== undefined) {
      data.outputMilliCreditsPer1k = priceInt(body.outputMilliCreditsPer1k);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_patch');

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // before 快照与更新同事务读取，避免审计记录与实际变更不一致。
        const before = await tx.modelPrice.findUnique({ where: { model } });
        if (!before) throw new NotFoundException('model_price_not_found');

        const updated = await tx.modelPrice.update({ where: { model }, data });
        await this.audit.write(tx, actor, {
          action: 'modelPrice.update',
          targetType: 'modelPrice',
          targetId: model,
          summary: { before: toDto(before), after: toDto(updated) },
        });
        return updated;
      });
      return toDto(row);
    } catch (err) {
      // 并发删除等场景下 Prisma 抛 P2025；Nest 业务异常不带 code，原样抛出。
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('model_price_not_found');
      }
      throw err;
    }
  }

  async remove(model: string, actor: AdminActor): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelPrice.findUnique({ where: { model } });
        if (!before) throw new NotFoundException('model_price_not_found');

        // 启用中的套餐仍引用该模型时禁止删除，避免下单后计费无价可查。
        const used = await tx.plan.findFirst({
          where: { active: true, allowedModels: { has: model } },
          select: { id: true },
        });
        if (used) throw new BadRequestException('model_in_use');

        await tx.modelPrice.delete({ where: { model } });
        await this.audit.write(tx, actor, {
          action: 'modelPrice.delete',
          targetType: 'modelPrice',
          targetId: model,
        });
      });
    } catch (err) {
      // 并发删除时 delete 同样可能抛 P2025，业务语义仍是价格不存在。
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('model_price_not_found');
      }
      throw err;
    }
  }
}
