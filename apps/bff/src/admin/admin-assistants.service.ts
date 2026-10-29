import { Injectable } from '@nestjs/common';
import {
  isAssistantPermissionMode,
  normalizeSkills,
  type AdminAssistantDto,
  type PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { parsePage } from './admin.util';

/** 运营端助手列表：只读排查，能看到公共内置助手与用户自定义助手。 */
@Injectable()
export class AdminAssistantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminAssistantDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const scope = query.scope === 'public' || query.scope === 'personal' ? query.scope : undefined;
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const where = {
      ...(scope ? { scope } : {}),
      ...(q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.assistant.findMany({ where, orderBy: [{ scope: 'asc' }, { updatedAt: 'desc' }], skip, take }),
      this.prisma.assistant.count({ where }),
    ]);

    const owners = [...new Set(rows.map((row) => row.userId))];
    const users = owners.length
      ? await this.prisma.user.findMany({
          where: { id: { in: owners } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(users.map((user) => [user.id, user.email]));

    const skillIds = [...new Set(rows.flatMap((row) => row.skillIds))];
    const skills = skillIds.length
      ? await this.prisma.skill.findMany({
          where: { id: { in: skillIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(skills.map((skill) => [skill.id, skill.name]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        scope: row.scope === 'public' ? 'public' : 'personal',
        name: row.name,
        description: row.description,
        systemPrompt: row.systemPrompt,
        ownerEmail: emailById.get(row.userId) ?? null,
        model: row.model ?? null,
        permissionMode: isAssistantPermissionMode(row.permissionMode)
          ? row.permissionMode
          : 'standard',
        skills: normalizeSkills(row.skills),
        skillIds: row.skillIds,
        skillNames: row.skillIds.map((id) => nameById.get(id) ?? '已删除技能'),
        kbIds: row.kbIds,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }
}
