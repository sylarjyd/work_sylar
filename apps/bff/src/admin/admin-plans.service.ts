import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Plan } from '@prisma/client';
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
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
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
    const rows = await this.prisma.plan.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toDto);
  }

  async create(body: AdminPlanInput, actor: AdminActor): Promise<AdminPlanDto> {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!PLAN_ID_RE.test(id)) throw new BadRequestException('invalid_plan_id');

    const input: AdminPlanInput = {
      id,
      name: nonEmptyString(body.name, 'name'),
      priceCents: nonNegativeInt(body.priceCents, 'priceCents'),
      monthlyBaseCredits: nonNegativeInt(body.monthlyBaseCredits, 'monthlyBaseCredits'),
      monthlyBonusCredits: nonNegativeInt(body.monthlyBonusCredits, 'monthlyBonusCredits'),
      maxCreditsPerRun: nonNegativeInt(body.maxCreditsPerRun, 'maxCreditsPerRun'),
      rpm: nonNegativeInt(body.rpm, 'rpm'),
      allowedModels: modelList(body.allowedModels),
      active: body.active === undefined ? true : Boolean(body.active),
    };
    // 套餐可用的每个模型都必须在模型价格表中，避免用户开到无价模型后计费失败。
    await this.assertModelsPriced(input.allowedModels);

    const exists = await this.prisma.plan.findUnique({ where: { id }, select: { id: true } });
    if (exists) throw new ConflictException('plan_exists');

    const row = await this.prisma.$transaction(async (tx) => {
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
  }

  async update(id: string, body: AdminPlanPatch, actor: AdminActor): Promise<AdminPlanDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('plan_not_found');

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
    if (patch.allowedModels) await this.assertModelsPriced(patch.allowedModels);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.plan.update({ where: { id }, data: patch });
      // 审计记录变更前后快照，便于追溯定价/额度调整。
      await this.audit.write(tx, actor, {
        action: 'plan.update',
        targetType: 'plan',
        targetId: id,
        summary: { before: toDto(plan), after: toDto(updated) },
      });
      return updated;
    });
    return toDto(row);
  }

  private async assertModelsPriced(models: string[]): Promise<void> {
    const found = await this.prisma.modelPrice.findMany({
      where: { model: { in: models } },
      select: { model: true },
    });
    if (found.length !== models.length) throw new BadRequestException('model_price_missing');
  }
}
