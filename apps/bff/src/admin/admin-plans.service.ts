import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Plan } from '@prisma/client';
import type { AdminPlanDto, AdminPlanInput, AdminPlanPatch } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

// 套餐 id 同时作为对外 slug：小写字母开头，仅允许小写字母、数字与连字符，长度 2-31。
const PLAN_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

function toDto(plan: Plan): AdminPlanDto {
  return {
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    monthlyBaseCredits: plan.monthlyBaseCredits,
    monthlyBonusCredits: plan.monthlyBonusCredits,
    maxCreditsPerRun: plan.maxCreditsPerRun,
    rpm: plan.rpm,
    allowedModels: plan.allowedModels,
    active: plan.active,
    createdAt: plan.createdAt.toISOString(),
  };
}

function nonNegativeInt(raw: unknown, field: string): number {
  // 数据库列均为 Int32，超出上限的数值会写入失败，提前以 400 拒绝。
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    throw new BadRequestException(`invalid_${field}`);
  }
  return raw;
}

function nonEmptyString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException(`invalid_${field}`);
  }
  return raw.trim();
}

function modelList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('invalid_allowedModels');
  const models = raw.map((m) => (typeof m === 'string' ? m.trim() : ''));
  if (models.some((m) => m === '')) throw new BadRequestException('invalid_allowedModels');
  return [...new Set(models)];
}

/** 管理端套餐目录：全量读取（含停用）、新建与局部更新，写操作与审计同事务。 */
@Injectable()
export class AdminPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listAll(): Promise<AdminPlanDto[]> {
    // 同毫秒创建的套餐按 id 兜底排序，保证列表顺序稳定。
    const rows = await this.prisma.plan.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDto);
  }

  async create(body: AdminPlanInput, actor: AdminActor): Promise<AdminPlanDto> {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!PLAN_ID_RE.test(id)) throw new BadRequestException('invalid_plan_id');

    let active = true;
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new BadRequestException('invalid_active');
      active = body.active;
    }

    const input: AdminPlanInput = {
      id,
      name: nonEmptyString(body.name, 'name'),
      priceCents: nonNegativeInt(body.priceCents, 'priceCents'),
      monthlyBaseCredits: nonNegativeInt(body.monthlyBaseCredits, 'monthlyBaseCredits'),
      monthlyBonusCredits: nonNegativeInt(body.monthlyBonusCredits, 'monthlyBonusCredits'),
      maxCreditsPerRun: nonNegativeInt(body.maxCreditsPerRun, 'maxCreditsPerRun'),
      rpm: nonNegativeInt(body.rpm, 'rpm'),
      allowedModels: modelList(body.allowedModels),
      active,
    };

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // 套餐可用的每个模型都必须在模型价格表中，避免用户开到无价模型后计费失败。
        await this.assertModelsPriced(tx, input.allowedModels);
        const created = await tx.plan.create({ data: input });
        await this.audit.write(tx, actor, {
          action: 'plan.create',
          targetType: 'plan',
          targetId: id,
          summary: { name: input.name },
        });
        return created;
      });
      return toDto(row);
    } catch (err) {
      // 并发创建同一 id 时由唯一约束兜底，避免先查后写的竞态。
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('plan_exists');
      }
      throw err;
    }
  }

  async update(id: string, body: AdminPlanPatch, actor: AdminActor): Promise<AdminPlanDto> {
    const patch: Partial<AdminPlanInput> = {};
    if (body?.name !== undefined) patch.name = nonEmptyString(body.name, 'name');
    const intFields = [
      'priceCents',
      'monthlyBaseCredits',
      'monthlyBonusCredits',
      'maxCreditsPerRun',
      'rpm',
    ] as const;
    for (const field of intFields) {
      if (body?.[field] !== undefined) patch[field] = nonNegativeInt(body[field], field);
    }
    if (body?.allowedModels !== undefined) patch.allowedModels = modelList(body.allowedModels);
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new BadRequestException('invalid_active');
      patch.active = body.active;
    }
    if (Object.keys(patch).length === 0) throw new BadRequestException('invalid_patch');

    // free 是注册默认套餐，停用会导致新租户无套餐可用，因此禁止停用。
    if (id === 'free' && patch.active === false) {
      throw new BadRequestException('free_not_deactivatable');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // before 快照与更新同事务读取，避免审计记录与实际变更不一致。
        const before = await tx.plan.findUnique({ where: { id } });
        if (!before) throw new NotFoundException('plan_not_found');
        if (patch.allowedModels) await this.assertModelsPriced(tx, patch.allowedModels);

        const updated = await tx.plan.update({ where: { id }, data: patch });
        // 审计记录变更前后快照，便于追溯定价/额度调整。
        await this.audit.write(tx, actor, {
          action: 'plan.update',
          targetType: 'plan',
          targetId: id,
          summary: { before: toDto(before), after: toDto(updated) },
        });
        return updated;
      });
      return toDto(row);
    } catch (err) {
      // 并发删除等场景下 Prisma 抛 P2025，业务语义仍是套餐不存在。
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('plan_not_found');
      }
      throw err;
    }
  }

  private async assertModelsPriced(tx: Prisma.TransactionClient, models: string[]): Promise<void> {
    // 锁定价格行，避免价格删除与套餐引用校验并发交错后留下无价模型。
    const found = await tx.$queryRaw<Array<{ model: string }>>`
      SELECT "model" FROM "ModelPrice" WHERE "model" IN (${Prisma.join(models)}) FOR UPDATE
    `;
    if (found.length !== models.length) throw new BadRequestException('model_price_missing');
  }
}
