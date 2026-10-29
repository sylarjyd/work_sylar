import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ASSISTANT_SKILL_KEYS,
  isAssistantPermissionMode,
  normalizeSkills,
  type AdminAssistantDto,
  type AssistantPermissionMode,
  type PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { parsePage } from './admin.util';

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;
const MAX_PROMPT = 8000;
const MAX_SKILL_BINDINGS = 20;

export interface AdminAssistantInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  permissionMode?: string;
  skills?: string[];
  skillIds?: string[];
}

/** 运营端助手管理：列表只读展示全部助手；公共（内置）助手可由运营端新建/编辑/删除。 */
@Injectable()
export class AdminAssistantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /** 运营端新建公共助手：所有租户可见、只读；归属记在管理员账号下便于审计。 */
  async create(
    input: AdminAssistantInput,
    owner: { tenantId: string; userId: string },
    actor: AdminActor,
  ): Promise<AdminAssistantDto> {
    const name = parseName(input.name);
    const description = parseDescription(input.description);
    const systemPrompt = parsePrompt(input.systemPrompt);
    const permissionMode = parsePermissionMode(input.permissionMode);
    const skills = parseSkills(input.skills);
    const skillIds = await this.parsePublicSkillIds(input.skillIds);

    const existing = await this.prisma.assistant.findFirst({
      where: { tenantId: owner.tenantId, userId: owner.userId, name, scope: 'public' },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('assistant_exists');

    const row = await this.prisma.assistant.create({
      data: {
        tenantId: owner.tenantId,
        userId: owner.userId,
        scope: 'public',
        name,
        description,
        systemPrompt,
        permissionMode,
        skills,
        skillIds,
        connectorIds: [],
        kbIds: [],
      },
    });
    await this.audit.bestEffort(actor, {
      action: 'assistant.create',
      targetType: 'assistant',
      targetId: row.id,
      summary: { name: row.name, scope: 'public' },
    });
    return this.toDto(row);
  }

  async update(
    id: string,
    input: AdminAssistantInput,
    actor: AdminActor,
  ): Promise<AdminAssistantDto> {
    await this.loadPublic(id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = parseName(input.name);
    if (input.description !== undefined) data.description = parseDescription(input.description);
    if (input.systemPrompt !== undefined) data.systemPrompt = parsePrompt(input.systemPrompt);
    if (input.permissionMode !== undefined) {
      data.permissionMode = parsePermissionMode(input.permissionMode);
    }
    if (input.skills !== undefined) data.skills = parseSkills(input.skills);
    if (input.skillIds !== undefined) data.skillIds = await this.parsePublicSkillIds(input.skillIds);
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_assistant_patch');

    const row = await this.prisma.assistant.update({ where: { id }, data });
    await this.audit.bestEffort(actor, {
      action: 'assistant.update',
      targetType: 'assistant',
      targetId: id,
      summary: { name: row.name },
    });
    return this.toDto(row);
  }

  async remove(id: string, actor: AdminActor): Promise<void> {
    const row = await this.loadPublic(id);
    // 会话外键 SetNull：删除助手不会删会话，历史会话退化为默认助手。
    await this.prisma.assistant.delete({ where: { id } });
    await this.audit.bestEffort(actor, {
      action: 'assistant.delete',
      targetType: 'assistant',
      targetId: id,
      summary: { name: row.name },
    });
  }

  private async loadPublic(id: string): Promise<{ id: string; name: string }> {
    const row = await this.prisma.assistant.findFirst({
      where: { id, scope: 'public' },
      select: { id: true, name: true },
    });
    if (!row) throw new NotFoundException('assistant_not_found');
    return row;
  }

  /** 公共助手只能绑定启用的公共技能；个人技能属于用户私域，不跨租户注入。 */
  private async parsePublicSkillIds(raw: unknown): Promise<string[]> {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_SKILL_BINDINGS) {
      throw new BadRequestException('invalid_skill_ids');
    }
    const ids: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new BadRequestException('invalid_skill_ids');
      }
      const id = item.trim();
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) return [];
    const count = await this.prisma.skill.count({
      where: { id: { in: ids }, scope: 'public', enabled: true },
    });
    if (count !== ids.length) throw new BadRequestException('invalid_skill_ids');
    return ids;
  }

  private toDto(row: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    permissionMode: string;
    model: string | null;
    skills: string[];
    skillIds: string[];
    kbIds: string[];
    createdAt: Date;
    updatedAt: Date;
  }): AdminAssistantDto {
    return {
      id: row.id,
      scope: 'public',
      name: row.name,
      description: row.description,
      systemPrompt: row.systemPrompt,
      ownerEmail: null,
      model: row.model ?? null,
      permissionMode: isAssistantPermissionMode(row.permissionMode)
        ? row.permissionMode
        : 'standard',
      skills: normalizeSkills(row.skills),
      skillIds: row.skillIds,
      skillNames: [],
      kbIds: row.kbIds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_name');
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME) throw new BadRequestException('invalid_name');
  return name;
}

function parseDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' || raw.trim().length > MAX_DESCRIPTION) {
    throw new BadRequestException('invalid_description');
  }
  return raw.trim();
}

function parsePrompt(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' || raw.length > MAX_PROMPT) {
    throw new BadRequestException('invalid_system_prompt');
  }
  return raw;
}

function parsePermissionMode(raw: unknown): AssistantPermissionMode {
  if (raw === undefined || raw === null) return 'standard';
  if (!isAssistantPermissionMode(raw)) throw new BadRequestException('invalid_permission_mode');
  return raw;
}

function parseSkills(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new BadRequestException('invalid_skills');
  }
  for (const item of raw) {
    if (!(ASSISTANT_SKILL_KEYS as readonly string[]).includes(item)) {
      throw new BadRequestException('invalid_skills');
    }
  }
  return normalizeSkills(raw as string[]);
}
