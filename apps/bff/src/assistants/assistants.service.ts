import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ASSISTANT_SKILL_KEYS,
  isAssistantPermissionMode,
  normalizeSkills,
  type AssistantDto,
  type AssistantInput,
  type AssistantPatch,
  type AssistantPermissionMode,
  type AssistantSkillKey,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;
const MAX_SYSTEM_PROMPT = 8000;
const MAX_KB_BASES = 100;

interface AssistantRow {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: string;
  model: string | null;
  skills: string[];
  kbIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** 用户自定义助手：所有读写按 tenantId + userId 做行级隔离。 */
@Injectable()
export class AssistantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<AssistantDto[]> {
    const rows = await this.prisma.assistant.findMany({
      where: { tenantId, userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toDto);
  }

  async create(
    tenantId: string,
    userId: string,
    input: AssistantInput,
  ): Promise<AssistantDto> {
    const name = parseName(input?.name);
    const description = parseDescription(input?.description ?? '');
    const systemPrompt = parseSystemPrompt(input?.systemPrompt ?? '');
    const permissionMode = parsePermissionMode(input?.permissionMode ?? 'standard');
    const model = parseModel(input?.model === undefined ? null : input.model);
    const skills = parseSkills(input?.skills ?? []);
    const kbIds = await this.parseKbIds(input?.kbIds ?? [], tenantId, userId);

    try {
      const row = await this.prisma.assistant.create({
        data: {
          tenantId,
          userId,
          name,
          description,
          systemPrompt,
          permissionMode,
          model,
          skills,
          kbIds,
        },
      });
      return toDto(row);
    } catch (err) {
      throw mapWriteError(err);
    }
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    patch: AssistantPatch,
  ): Promise<AssistantDto> {
    await this.assertOwned(id, tenantId, userId);
    const data: {
      name?: string;
      description?: string;
      systemPrompt?: string;
      permissionMode?: AssistantPermissionMode;
      model?: string | null;
      skills?: AssistantSkillKey[];
      kbIds?: string[];
    } = {};
    if (patch && Object.hasOwn(patch, 'name')) data.name = parseName(patch.name);
    if (patch && Object.hasOwn(patch, 'description')) {
      data.description = parseDescription(patch.description ?? '');
    }
    if (patch && Object.hasOwn(patch, 'systemPrompt')) {
      data.systemPrompt = parseSystemPrompt(patch.systemPrompt ?? '');
    }
    if (patch && Object.hasOwn(patch, 'permissionMode')) {
      data.permissionMode = parsePermissionMode(patch.permissionMode ?? 'standard');
    }
    if (patch && Object.hasOwn(patch, 'model')) data.model = parseModel(patch.model ?? null);
    if (patch && Object.hasOwn(patch, 'skills')) data.skills = parseSkills(patch.skills ?? []);
    if (patch && Object.hasOwn(patch, 'kbIds')) {
      data.kbIds = await this.parseKbIds(patch.kbIds ?? [], tenantId, userId);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_assistant_patch');

    try {
      const row = await this.prisma.assistant.update({ where: { id }, data });
      return toDto(row);
    } catch (err) {
      throw mapWriteError(err);
    }
  }

  async remove(id: string, tenantId: string, userId: string): Promise<void> {
    await this.assertOwned(id, tenantId, userId);
    // 会话外键为 SetNull：删除助手不会删会话，历史会话退化为默认助手。
    await this.prisma.assistant.delete({ where: { id } });
  }

  private async assertOwned(id: string, tenantId: string, userId: string): Promise<void> {
    const row = await this.prisma.assistant.findFirst({
      where: { id, tenantId, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('assistant_not_found');
  }

  /** 绑定的知识库必须属于当前用户；空数组表示检索全部知识库。 */
  private async parseKbIds(raw: unknown, tenantId: string, userId: string): Promise<string[]> {
    if (!Array.isArray(raw) || raw.length > MAX_KB_BASES) {
      throw new BadRequestException('invalid_kb_ids');
    }
    const ids: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new BadRequestException('invalid_kb_ids');
      }
      const id = item.trim();
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) return [];
    const count = await this.prisma.knowledgeBase.count({
      where: { id: { in: ids }, tenantId, userId },
    });
    if (count !== ids.length) throw new BadRequestException('invalid_kb_ids');
    return ids;
  }
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_name');
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    throw new BadRequestException('invalid_name');
  }
  return name;
}

function parseDescription(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_DESCRIPTION) {
    throw new BadRequestException('invalid_description');
  }
  return raw;
}

function parseSystemPrompt(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_SYSTEM_PROMPT) {
    throw new BadRequestException('invalid_system_prompt');
  }
  return raw;
}

function parsePermissionMode(raw: unknown): AssistantPermissionMode {
  if (!isAssistantPermissionMode(raw)) {
    throw new BadRequestException('invalid_permission_mode');
  }
  return raw;
}

function parseModel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 200) {
    throw new BadRequestException('invalid_model');
  }
  return raw.trim();
}

function parseSkills(raw: unknown): AssistantSkillKey[] {
  if (!Array.isArray(raw)) throw new BadRequestException('invalid_skills');
  for (const item of raw) {
    if (typeof item !== 'string' || !ASSISTANT_SKILL_KEYS.includes(item)) {
      throw new BadRequestException('invalid_skills');
    }
  }
  return normalizeSkills(raw);
}

function mapWriteError(err: unknown): unknown {
  if (err instanceof ConflictException) return err;
  const e = err as { code?: string };
  if (e?.code === 'P2002') return new ConflictException('assistant_exists');
  return err;
}

function toDto(row: AssistantRow): AssistantDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    permissionMode: isAssistantPermissionMode(row.permissionMode)
      ? row.permissionMode
      : 'standard',
    model: row.model ?? null,
    skills: normalizeSkills(row.skills),
    kbIds: row.kbIds ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
