import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  normalizeSkillInput,
  type PageDto,
  type SkillDto,
} from '@ai-office/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { ATTACHMENT_STORAGE, type AttachmentStorage } from '../attachments/attachments.storage';
import { parseSkillPackage, readSkillPackageFile, SkillPackageError } from '../skills/skill-package';
import { parsePage } from './admin.util';

interface SkillRow {
  id: string;
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

/**
 * 运营端技能管理：能看到全部技能（区分公共/个人），但只维护公共技能；
 * 个人技能属于用户私域，运营端仅做只读排查，避免越权改写用户内容。
 */
@Injectable()
export class AdminSkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ATTACHMENT_STORAGE) private readonly storage: AttachmentStorage,
  ) {}

  async list(query: Record<string, unknown>, actor: AdminActor): Promise<PageDto<SkillDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const scope = query.scope === 'public' || query.scope === 'personal' ? query.scope : undefined;
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const where = {
      ...(scope ? { scope } : {}),
      ...(q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.skill.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take }),
      this.prisma.skill.count({ where }),
    ]);
    const owners = [...new Set(rows.map((r) => r.ownerUserId).filter((v): v is string => !!v))];
    const users = owners.length
      ? await this.prisma.user.findMany({
          where: { id: { in: owners } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    await this.audit.bestEffort(actor, {
      action: 'skill.list',
      targetType: 'skill',
      summary: { page, pageSize, scope: scope ?? 'all', hasQuery: q !== '' },
    });
    return {
      items: rows.map((row) => toAdminDto(row, emailById.get(row.ownerUserId ?? '') ?? null)),
      total,
      page,
      pageSize,
    };
  }

  /** 运营端创建的是公共技能（owner 为空、跨租户）。 */
  async create(body: unknown, actor: AdminActor): Promise<SkillDto> {
    const input = normalizeSkillInput(body);
    if (!input) throw new BadRequestException('invalid_skill');
    const row = await this.prisma.skill.create({
      data: {
        scope: 'public',
        source: 'manual',
        enabled: true,
        name: input.name,
        slug: input.slug ?? input.name,
        description: input.description ?? '',
        content: input.content,
        version: input.version ?? null,
        license: input.license ?? null,
        allowedTools: input.allowedTools ?? [],
      },
    });
    await this.audit.bestEffort(actor, {
      action: 'skill.create',
      targetType: 'skill',
      targetId: row.id,
      summary: { name: row.name },
    });
    return toAdminDto(row, null);
  }

  /** 运营端上传公共技能包：解析 SKILL.md，zip 存对象存储。 */
  async createFromPackage(buffer: Buffer, actor: AdminActor): Promise<SkillDto> {
    let parsed: ReturnType<typeof parseSkillPackage>;
    try {
      parsed = parseSkillPackage(buffer);
    } catch (err) {
      if (err instanceof SkillPackageError) throw new BadRequestException(err.code);
      throw new BadRequestException('invalid_skill_package');
    }
    const input = parsed.meta;
    const packageKey = `skills/public/${randomUUID()}/${input.slug ?? 'skill'}.zip`;
    await this.storage.putObject(packageKey, buffer, 'application/zip');
    try {
      const row = await this.prisma.skill.create({
        data: {
          scope: 'public',
          source: 'upload',
          enabled: true,
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
      await this.audit.bestEffort(actor, {
        action: 'skill.create',
        targetType: 'skill',
        targetId: row.id,
        summary: { name: row.name, source: 'upload' },
      });
      return toAdminDto(row, null);
    } catch (err) {
      await this.storage.deleteObject(packageKey).catch(() => undefined);
      throw err;
    }
  }

  /** 运营端预览技能包内文件（仅公共技能）。 */
  async readPackageFile(
    id: string,
    path: string,
    actor: AdminActor,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.loadPublic(id);
    if (!row.packageKey) throw new NotFoundException('skill_package_missing');
    const zip = await this.storage.getObjectBuffer(row.packageKey);
    const bytes = readSkillPackageFile(zip, path);
    if (!bytes) throw new NotFoundException('skill_file_not_found');
    await this.audit.bestEffort(actor, {
      action: 'skill.file.view',
      targetType: 'skill',
      targetId: id,
      summary: { path },
    });
    return { buffer: Buffer.from(bytes), filename: path.split('/').pop() ?? 'file' };
  }

  async update(id: string, body: unknown, actor: AdminActor): Promise<SkillDto> {
    await this.loadPublic(id);
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
    await this.audit.bestEffort(actor, {
      action: 'skill.update',
      targetType: 'skill',
      targetId: id,
      summary: { name: row.name },
    });
    return toAdminDto(row, null);
  }

  async setEnabled(id: string, enabled: boolean, actor: AdminActor): Promise<SkillDto> {    await this.loadPublic(id);
    const row = await this.prisma.skill.update({ where: { id }, data: { enabled } });
    await this.audit.bestEffort(actor, {
      action: 'skill.enable',
      targetType: 'skill',
      targetId: id,
      summary: { enabled },
    });
    return toAdminDto(row, null);
  }

  async remove(id: string, actor: AdminActor): Promise<void> {
    await this.loadPublic(id);
    await this.prisma.skill.delete({ where: { id } });
    await this.audit.bestEffort(actor, {
      action: 'skill.delete',
      targetType: 'skill',
      targetId: id,
    });
  }

  private async loadPublic(id: string): Promise<SkillRow> {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('skill_not_found');
    // 个人技能只读：允许运营端看，但不允许改写/删除用户私域内容。
    if (row.scope !== 'public') throw new BadRequestException('skill_not_public');
    return row;
  }
}

function toAdminDto(row: SkillRow, ownerEmail: string | null): SkillDto {
  const source = row.source === 'upload' ? 'upload' : row.source === 'run' ? 'run' : 'manual';
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
    files: Array.isArray(row.files)
      ? (row.files as Array<{ path?: unknown; size?: unknown }>)
          .filter((file) => typeof file?.path === 'string')
          .map((file) => ({
            path: String(file.path),
            size: typeof file.size === 'number' ? file.size : 0,
          }))
      : [],
    packageSize: row.packageSize ?? null,
    source,
    enabled: row.enabled,
    owned: false,
    ownerEmail,
    sharedAt: row.sharedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
