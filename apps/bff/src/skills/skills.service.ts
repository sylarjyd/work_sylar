import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  normalizeSkillInput,
  type RunSkill,
  type SkillDto,
  type SkillListDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';

interface SkillRow {
  id: string;
  tenantId: string | null;
  ownerUserId: string | null;
  scope: string;
  name: string;
  description: string;
  content: string;
  source: string;
  sharedAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: SkillRow, userId: string): SkillDto {
  return {
    id: row.id,
    scope: row.scope === 'public' ? 'public' : 'personal',
    name: row.name,
    description: row.description,
    content: row.content,
    source: row.source === 'run' ? 'run' : 'manual',
    enabled: row.enabled,
    owned: row.ownerUserId !== null && row.ownerUserId === userId,
    sharedAt: row.sharedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 技能市场的用户侧：公共技能人人可见，个人技能仅创建者可见。
 * 共享是单向的（personal → public），共享后由运营端接管维护，创建者不再独占编辑权。
 */
@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<SkillListDto> {
    const rows = await this.prisma.skill.findMany({
      where: {
        OR: [
          { scope: 'public', enabled: true },
          { scope: 'personal', tenantId, ownerUserId: userId },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return { items: rows.map((row) => toDto(row, userId)) };
  }

  async create(tenantId: string, userId: string, body: unknown): Promise<SkillDto> {
    const input = normalizeSkillInput(body);
    if (!input) throw new BadRequestException('invalid_skill');
    const row = await this.prisma.skill.create({
      data: { tenantId, ownerUserId: userId, scope: 'personal', ...input },
    });
    return toDto(row, userId);
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    body: unknown,
  ): Promise<SkillDto> {
    await this.loadOwned(id, tenantId, userId);
    const input = normalizeSkillInput(body);
    if (!input) throw new BadRequestException('invalid_skill');
    const row = await this.prisma.skill.update({ where: { id }, data: input });
    return toDto(row, userId);
  }

  async remove(id: string, tenantId: string, userId: string): Promise<void> {
    await this.loadOwned(id, tenantId, userId);
    await this.prisma.skill.delete({ where: { id } });
  }

  /** 共享为公共技能：保留创建者与来源信息，之后由运营端维护。 */
  async share(id: string, tenantId: string, userId: string): Promise<SkillDto> {
    await this.loadOwned(id, tenantId, userId);
    const row = await this.prisma.skill.update({
      where: { id },
      data: { scope: 'public', sharedAt: new Date(), enabled: true },
    });
    return toDto(row, userId);
  }

  /**
   * 任务结束后由模型总结出的技能：落为该用户的个人技能。
   * 同一 run 重复上报（重试/重放）时更新原记录，避免生成多条同源技能。
   */
  async saveFromRun(
    scope: { tenantId: string; userId: string; runId: string },
    body: unknown,
  ): Promise<SkillDto | null> {
    const input = normalizeSkillInput(body);
    if (!input) return null;
    const existing = await this.prisma.skill.findFirst({
      where: { sourceRunId: scope.runId, ownerUserId: scope.userId },
      select: { id: true },
    });
    if (existing) {
      const row = await this.prisma.skill.update({ where: { id: existing.id }, data: input });
      return toDto(row, scope.userId);
    }
    const row = await this.prisma.skill.create({
      data: {
        tenantId: scope.tenantId,
        ownerUserId: scope.userId,
        scope: 'personal',
        source: 'run',
        sourceRunId: scope.runId,
        ...input,
      },
    });
    return toDto(row, scope.userId);
  }

  /**
   * 运行期解析绑定技能：只接受「启用的公共技能」或「本人个人技能」，
   * 未知/越权 id 直接丢弃，避免一次非法绑定让整轮运行失败。
   */
  async resolveForRun(
    ids: readonly string[],
    tenantId: string,
    userId: string,
  ): Promise<RunSkill[]> {
    const unique = [...new Set(ids)].filter((value) => typeof value === 'string' && value !== '');
    if (unique.length === 0) return [];
    const rows = await this.prisma.skill.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, content: true, scope: true, enabled: true, tenantId: true, ownerUserId: true },
    });
    const allowed = new Map(
      rows
        .filter(
          (row) =>
            (row.scope === 'public' && row.enabled) ||
            (row.scope === 'personal' && row.tenantId === tenantId && row.ownerUserId === userId),
        )
        .map((row) => [row.id, row]),
    );
    return unique
      .map((id) => allowed.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => ({ id: row.id, name: row.name, content: row.content }));
  }

  private async loadOwned(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<SkillRow> {
    const row = await this.prisma.skill.findFirst({
      where: { id, scope: 'personal', tenantId, ownerUserId: userId },
    });
    if (!row) throw new NotFoundException('skill_not_found');
    return row;
  }
}
