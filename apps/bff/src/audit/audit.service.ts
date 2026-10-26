import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AdminAuditItemDto, PageDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { optionalDate, optionalString, parsePage } from '../admin/admin.util';
import type { AdminActor } from './audit.types';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  summary?: Record<string, unknown> | null;
}

type Db = Prisma.TransactionClient;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 写操作审计：必须与业务写入同事务，失败即整体回滚。 */
  async write(tx: Db, actor: AdminActor, entry: AuditEntry): Promise<void> {
    await tx.adminAuditLog.create({ data: toData(actor, entry) });
  }

  /**
   * 非事务写操作审计：业务已产生队列/总线等外部副作用、无法与业务写入同事务时使用。
   * 与 bestEffort 不同，写失败直接上抛，保证必审操作不会静默丢审计。
   */
  async record(actor: AdminActor, entry: AuditEntry): Promise<void> {
    await this.prisma.adminAuditLog.create({ data: toData(actor, entry) });
  }

  /** 敏感查看审计：读取成功后调用；写失败只记日志，不阻断读取。 */
  async bestEffort(actor: AdminActor, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({ data: toData(actor, entry) });
    } catch (err) {
      this.logger.warn(`审计写入失败 action=${entry.action}: ${(err as Error).message}`);
    }
  }

  async list(query: Record<string, unknown>): Promise<PageDto<AdminAuditItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const action = optionalString(query.action);
    const targetType = optionalString(query.targetType);
    const targetId = optionalString(query.targetId);
    const actorId = optionalString(query.actorId);
    const from = optionalDate(query.from, 'invalid_from');
    const to = optionalDate(query.to, 'invalid_to');

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(actorId ? { actorId } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        summary: (r.summary ?? null) as Record<string, unknown> | null,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }
}

function toData(actor: AdminActor, entry: AuditEntry): Prisma.AdminAuditLogUncheckedCreateInput {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    summary:
      entry.summary === undefined || entry.summary === null
        ? undefined
        : (entry.summary as Prisma.InputJsonValue),
    ip: actor.ip ?? null,
  };
}
