import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  normalizeSkillInput,
  type RunSkill,
  type SkillDto,
  type SkillFileEntry,
  type SkillListDto,
} from '@ai-office/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { ATTACHMENT_STORAGE, type AttachmentStorage } from '../attachments/attachments.storage';
import { parseSkillPackage, readSkillPackageFile, SkillPackageError } from './skill-package';

interface SkillRow {
  id: string;
  tenantId: string | null;
  ownerUserId: string | null;
  scope: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  version: string | null;
  license: string | null;
  allowedTools: string[];
  packageKey: string | null;
  packageSize: number | null;
  files: unknown;
  source: string;
  sharedAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SOURCES = new Set(['manual', 'upload', 'run']);

function toFiles(raw: unknown): SkillFileEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillFileEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as { path?: unknown; size?: unknown };
    if (typeof row.path !== 'string' || row.path === '') continue;
    out.push({ path: row.path, size: typeof row.size === 'number' ? row.size : 0 });
  }
  return out;
}

function toDto(row: SkillRow, userId: string): SkillDto {
  return {
    id: row.id,
    scope: row.scope === 'public' ? 'public' : 'personal',
    slug: row.slug || row.name,
    name: row.name,
    description: row.description,
    content: row.content,
    version: row.version ?? null,
    license: row.license ?? null,
    allowedTools: row.allowedTools ?? [],
    files: toFiles(row.files),
    packageSize: row.packageSize ?? null,
    source: SOURCES.has(row.source) ? (row.source as SkillDto['source']) : 'manual',
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
 * 技能遵循 Agent Skills 规范：SKILL.md 正文 + 可选 zip 包内资源。
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ATTACHMENT_STORAGE) private readonly storage: AttachmentStorage,
  ) {}

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
      data: {
        tenantId,
        ownerUserId: userId,
        scope: 'personal',
        name: input.name,
        slug: input.slug ?? input.name,
        description: input.description ?? '',
        content: input.content,
        version: input.version ?? null,
        license: input.license ?? null,
        allowedTools: input.allowedTools ?? [],
      },
    });
    return toDto(row, userId);
  }

  /** 上传技能包：解析 SKILL.md，zip 原样存对象存储，清单入库。 */
  async createFromPackage(
    tenantId: string,
    userId: string,
    buffer: Buffer,
  ): Promise<SkillDto> {
    let parsed: ReturnType<typeof parseSkillPackage>;
    try {
      parsed = parseSkillPackage(buffer);
    } catch (err) {
      if (err instanceof SkillPackageError) throw new BadRequestException(err.code);
      throw new BadRequestException('invalid_skill_package');
    }
    const input = parsed.meta;
    const packageKey = `skills/${tenantId}/${userId}/${randomUUID()}/${input.slug ?? 'skill'}.zip`;
    await this.storage.putObject(packageKey, buffer, 'application/zip');
    try {
      const row = await this.prisma.skill.create({
        data: {
          tenantId,
          ownerUserId: userId,
          scope: 'personal',
          source: 'upload',
          name: input.name,
          slug: input.slug ?? input.name,
          description: input.description ?? '',
          content: input.content,
          version: input.version ?? null,
          license: input.license ?? null,
          allowedTools: input.allowedTools ?? [],
          packageKey,
          packageSize: buffer.byteLength,
          files: parsed.files as unknown as Prisma.InputJsonValue,
        },
      });
      return toDto(row, userId);
    } catch (err) {
      // 元数据落库失败时清掉对象，避免留下不可见的孤儿包。
      await this.storage.deleteObject(packageKey).catch(() => undefined);
      throw err;
    }
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
    const row = await this.prisma.skill.update({
      where: { id },
      data: {
        name: input.name,
        ...(input.slug ? { slug: input.slug } : {}),
        description: input.description ?? '',
        content: input.content,
        version: input.version ?? null,
        license: input.license ?? null,
        allowedTools: input.allowedTools ?? [],
      },
    });
    return toDto(row, userId);
  }

  async remove(id: string, tenantId: string, userId: string): Promise<void> {
    const row = await this.loadOwned(id, tenantId, userId);
    await this.prisma.skill.delete({ where: { id } });
    if (row.packageKey) await this.storage.deleteObject(row.packageKey).catch(() => undefined);
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
      const row = await this.prisma.skill.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          description: input.description ?? '',
          content: input.content,
        },
      });
      return toDto(row, scope.userId);
    }
    const row = await this.prisma.skill.create({
      data: {
        tenantId: scope.tenantId,
        ownerUserId: scope.userId,
        scope: 'personal',
        source: 'run',
        sourceRunId: scope.runId,
        name: input.name,
        slug: input.slug ?? input.name,
        description: input.description ?? '',
        content: input.content,
      },
    });
    return toDto(row, scope.userId);
  }

  /** 读取技能包内文件：先校验可见性，再从 zip 解出指定路径。 */
  async readPackageFile(
    id: string,
    scope: { tenantId: string; userId: string },
    path: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.loadVisible(id, scope.tenantId, scope.userId);
    if (!row.packageKey) throw new NotFoundException('skill_package_missing');
    const zip = await this.storage.getObjectBuffer(row.packageKey);
    const bytes = readSkillPackageFile(zip, path);
    if (!bytes) throw new NotFoundException('skill_file_not_found');
    return { buffer: Buffer.from(bytes), filename: path.split('/').pop() ?? 'file' };
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
      select: {
        id: true,
        name: true,
        content: true,
        files: true,
        scope: true,
        enabled: true,
        tenantId: true,
        ownerUserId: true,
      },
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
      .map((row) => ({
        id: row.id,
        name: row.name,
        content: row.content,
        ...(toFiles(row.files).length > 0 ? { files: toFiles(row.files).map((f) => f.path) } : {}),
      }));
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

  private async loadVisible(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<SkillRow> {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    const visible =
      row !== null &&
      ((row.scope === 'public' && row.enabled) ||
        (row.scope === 'personal' && row.tenantId === tenantId && row.ownerUserId === userId));
    if (!row || !visible) throw new NotFoundException('skill_not_found');
    return row;
  }
}
