import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminKbBaseDetailDto,
  AdminKbBaseItemDto,
  AdminKbDeleteInput,
  AdminKbDocDeleteInput,
  AdminKbStatsDto,
  KbBaseDto,
  KbDeleteResultDto,
  KbDocDto,
  KbDocStatus,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { KB_STORAGE, type KbStorage } from '../kb/storage';
import { cleanupStorageObjects } from '../kb/storage-cleanup';
import { optionalString, parsePage } from './admin.util';

interface BaseRow {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DocRow {
  id: string;
  knowledgeBaseId: string | null;
  filename: string;
  mime: string;
  size: number;
  status: string;
  chunkCount: number;
  error: string | null;
  createdAt: Date;
}

type BaseStats = Pick<
  KbBaseDto,
  'docCount' | 'readyCount' | 'pendingCount' | 'failedCount' | 'chunkCount' | 'totalBytes'
>;

const EMPTY_STATS: BaseStats = {
  docCount: 0,
  readyCount: 0,
  pendingCount: 0,
  failedCount: 0,
  chunkCount: 0,
  totalBytes: 0,
};

/** 运营端知识库：跨租户查看列表/详情/统计，删除库与文档并要求二次确认与审计。 */
@Injectable()
export class AdminKbService {
  private readonly logger = new Logger(AdminKbService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(KB_STORAGE) private readonly storage: KbStorage,
  ) {}

  async stats(): Promise<AdminKbStatsDto> {
    const [baseCount, groups, tenants] = await Promise.all([
      this.prisma.knowledgeBase.count(),
      this.prisma.kbDoc.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { chunkCount: true, size: true },
      }),
      // 只取租户维度做去重，无需回表读取名称。
      this.prisma.knowledgeBase.groupBy({ by: ['tenantId'] }),
    ]);
    const out: AdminKbStatsDto = {
      baseCount,
      docCount: 0,
      readyCount: 0,
      pendingCount: 0,
      failedCount: 0,
      chunkCount: 0,
      totalBytes: 0,
      tenantCount: tenants.length,
    };
    for (const g of groups) {
      const count = g._count._all;
      out.docCount += count;
      if (g.status === 'ready') out.readyCount += count;
      else if (g.status === 'pending') out.pendingCount += count;
      else if (g.status === 'failed') out.failedCount += count;
      out.chunkCount += g._sum.chunkCount ?? 0;
      out.totalBytes += g._sum.size ?? 0;
    }
    return out;
  }

  async list(query: Record<string, unknown>): Promise<PageDto<AdminKbBaseItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const tenantId = optionalString(query.tenantId);
    const q = optionalString(query.q);

    // 关键词同时匹配库名与所有者邮箱；邮箱需先换算成 userId。
    const nameFilter: Prisma.KnowledgeBaseWhereInput[] = q
      ? [{ name: { contains: q, mode: 'insensitive' } }]
      : [];
    if (q) {
      const owners = await this.prisma.user.findMany({
        where: {
          email: { contains: q, mode: 'insensitive' },
          ...(tenantId ? { tenantId } : {}),
        },
        select: { id: true },
        // 关键词检索不需要枚举全库用户；超出范围时仍按库名命中。
        take: 1000,
      });
      if (owners.length > 0) nameFilter.push({ userId: { in: owners.map((u) => u.id) } });
    }
    const where: Prisma.KnowledgeBaseWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(nameFilter.length > 0 ? { OR: nameFilter } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.knowledgeBase.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.knowledgeBase.count({ where }),
    ]);
    const items = await this.toItems(rows);
    return { items, total, page, pageSize };
  }

  async detail(
    id: string,
    query: Record<string, unknown>,
  ): Promise<AdminKbBaseDetailDto> {
    const { page, pageSize, skip, take } = parsePage(query.docPage, query.docPageSize);
    const base = await this.prisma.knowledgeBase.findUnique({ where: { id } });
    if (!base) throw new NotFoundException('kb_base_not_found');

    const [items, docRows, docsTotal] = await Promise.all([
      this.toItems([base]),
      this.prisma.kbDoc.findMany({
        where: { knowledgeBaseId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.kbDoc.count({ where: { knowledgeBaseId: id } }),
    ]);
    const docs: PageDto<KbDocDto> = {
      items: docRows.map(toDocDto),
      total: docsTotal,
      page,
      pageSize,
    };
    return { ...items[0], docs };
  }

  /** 删库：事务内确认库名、解绑助手、级联删除，提交后清理对象存储。 */
  async deleteBase(
    id: string,
    input: AdminKbDeleteInput | undefined,
    actor: AdminActor,
  ): Promise<KbDeleteResultDto> {
    const confirmName = typeof input?.confirmName === 'string' ? input.confirmName : '';
    const { deletedDocs, storageKeys } = await this.prisma.$transaction(async (tx) => {
      const base = await tx.knowledgeBase.findUnique({
        where: { id },
        select: { id: true, name: true, tenantId: true, userId: true },
      });
      if (!base) throw new NotFoundException('kb_base_not_found');
      // 精确匹配库名，避免误删同名/相似的库。
      if (confirmName !== base.name) throw new BadRequestException('confirm_mismatch');

      const docs = await tx.kbDoc.findMany({
        where: { knowledgeBaseId: id },
        select: { storageKey: true },
      });
      await tx.$executeRaw`
        UPDATE "Assistant"
        SET "kbIds" = array_remove("kbIds", ${id})
        WHERE "tenantId" = ${base.tenantId} AND ${id} = ANY("kbIds")
      `;
      await tx.knowledgeBase.delete({ where: { id } });
      await this.audit.write(tx, actor, {
        action: 'kb.base.delete',
        targetType: 'kb_base',
        targetId: id,
        summary: {
          name: base.name,
          tenantId: base.tenantId,
          userId: base.userId,
          deletedDocs: docs.length,
        },
      });
      return { deletedDocs: docs.length, storageKeys: docs.map((d) => d.storageKey) };
    });

    const cleanupFailed = await this.cleanup(actor, 'kb_base', id, storageKeys);
    return { deletedDocs, cleanupFailed };
  }

  /** 删文档：确认 ID 后级联删除切片，提交后清理对象存储。 */
  async deleteDoc(
    baseId: string,
    docId: string,
    input: AdminKbDocDeleteInput | undefined,
    actor: AdminActor,
  ): Promise<KbDeleteResultDto> {
    const confirmId = typeof input?.confirmId === 'string' ? input.confirmId : '';
    if (confirmId !== docId) throw new BadRequestException('confirm_mismatch');

    const storageKey = await this.prisma.$transaction(async (tx) => {
      const base = await tx.knowledgeBase.findUnique({
        where: { id: baseId },
        select: { id: true },
      });
      if (!base) throw new NotFoundException('kb_base_not_found');
      const doc = await tx.kbDoc.findFirst({
        where: { id: docId, knowledgeBaseId: baseId },
        select: { id: true, filename: true, storageKey: true },
      });
      if (!doc) throw new NotFoundException('kb_doc_not_found');

      await tx.kbDoc.delete({ where: { id: docId } });
      await this.audit.write(tx, actor, {
        action: 'kb.doc.delete',
        targetType: 'kb_doc',
        targetId: docId,
        summary: { baseId, filename: doc.filename },
      });
      return doc.storageKey;
    });

    const cleanupFailed = await this.cleanup(actor, 'kb_doc', docId, [storageKey]);
    return { deletedDocs: 1, cleanupFailed };
  }

  /** 对象存储清理失败不影响删除结果，但要留审计便于后续清理孤儿对象。 */
  private async cleanup(
    actor: AdminActor,
    targetType: string,
    targetId: string,
    keys: string[],
  ): Promise<number> {
    const { failed } = await cleanupStorageObjects(this.storage, keys, this.logger);
    if (failed.length > 0) {
      await this.audit.bestEffort(actor, {
        action: 'kb.storage_cleanup_failed',
        targetType,
        targetId,
        summary: { failed: failed.length },
      });
    }
    return failed.length;
  }

  /** 批量补所有者邮箱、租户名称，并按库聚合文档统计。 */
  private async toItems(rows: BaseRow[]): Promise<AdminKbBaseItemDto[]> {
    if (rows.length === 0) return [];
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [tenants, users, groups] = await Promise.all([
      this.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      }),
      this.prisma.kbDoc.groupBy({
        by: ['knowledgeBaseId', 'status'],
        where: { knowledgeBaseId: { in: rows.map((r) => r.id) } },
        _count: { _all: true },
        _sum: { chunkCount: true, size: true },
      }),
    ]);
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));
    const stats = new Map<string, BaseStats>();
    for (const g of groups) {
      if (!g.knowledgeBaseId) continue;
      const item = stats.get(g.knowledgeBaseId) ?? { ...EMPTY_STATS };
      const count = g._count._all;
      item.docCount += count;
      if (g.status === 'ready') item.readyCount += count;
      else if (g.status === 'pending') item.pendingCount += count;
      else if (g.status === 'failed') item.failedCount += count;
      item.chunkCount += g._sum.chunkCount ?? 0;
      item.totalBytes += g._sum.size ?? 0;
      stats.set(g.knowledgeBaseId, item);
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      ...(stats.get(row.id) ?? EMPTY_STATS),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      tenantId: row.tenantId,
      tenantName: tenantName.get(row.tenantId) ?? row.tenantId,
      userId: row.userId,
      userEmail: userEmail.get(row.userId) ?? '',
    }));
  }
}

/** 与客户端 DTO 保持一致；storageKey 只用于内部清理，绝不对外返回。 */
function toDocDto(row: DocRow): KbDocDto {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId ?? '',
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    status: row.status as KbDocStatus,
    chunkCount: row.chunkCount,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}
