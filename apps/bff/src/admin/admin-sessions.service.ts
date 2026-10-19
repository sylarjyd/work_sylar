import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminMessageDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { optionalString, parsePage } from './admin.util';

interface SessionRow {
  id: string;
  title: string;
  status: string;
  tenantId: string;
  createdAt: Date;
  user: { email: string };
  _count: { messages: number; tasks: number };
}

function isStatus(v: unknown): v is 'active' | 'archived' {
  return v === 'active' || v === 'archived';
}

function toItem(row: SessionRow): AdminSessionItemDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    tenantId: row.tenantId,
    userEmail: row.user.email,
    messageCount: row._count.messages,
    taskCount: row._count.tasks,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 管理端会话：跨租户检索、详情、消息查看与归档；敏感查看与写操作均留审计。 */
@Injectable()
export class AdminSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminSessionItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const tenantId = optionalString(query.tenantId);
    const userId = optionalString(query.userId);
    const q = optionalString(query.q);
    const status = optionalString(query.status);
    if (status !== undefined && !isStatus(status)) throw new BadRequestException('invalid_status');

    const where: Prisma.SessionWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(userId ? { userId } : {}),
      ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      ...(status ? { status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        include: {
          user: { select: { email: true } },
          _count: { select: { messages: true, tasks: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.session.count({ where }),
    ]);

    return { items: rows.map(toItem), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminSessionDetailDto> {
    const row = await this.getSession(id);
    const artifactCount = await this.prisma.artifact.count({ where: { sessionId: id } });
    // 敏感查看审计：失败只记日志，不影响详情返回。
    await this.audit.bestEffort(actor, {
      action: 'session.view',
      targetType: 'session',
      targetId: id,
    });
    return { ...toItem(row), artifactCount };
  }

  async messages(
    id: string,
    query: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<PageDto<AdminMessageDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const exists = await this.prisma.session.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('session_not_found');

    const [rows, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { sessionId: id },
        orderBy: { seq: 'asc' },
        skip,
        take,
      }),
      this.prisma.message.count({ where: { sessionId: id } }),
    ]);

    // 不记录正文：只记会话与分页范围。
    await this.audit.bestEffort(actor, {
      action: 'messages.view',
      targetType: 'session',
      targetId: id,
      summary: { page, pageSize },
    });

    return {
      items: rows.map((m) => ({
        id: m.id,
        role: m.role as AdminMessageDto['role'],
        content: m.content,
        seq: m.seq,
        createdAt: m.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async archive(id: string, actor: AdminActor): Promise<AdminSessionItemDto> {
    const row = await this.getSession(id);
    await this.prisma.$transaction(async (tx) => {
      try {
        await tx.session.update({ where: { id }, data: { status: 'archived' } });
      } catch (err) {
        // 并发删除时 Prisma 抛 P2025，转为 404；其他异常原样抛出。
        if ((err as { code?: string }).code === 'P2025') {
          throw new NotFoundException('session_not_found');
        }
        throw err;
      }
      await this.audit.write(tx, actor, {
        action: 'session.archive',
        targetType: 'session',
        targetId: id,
        summary: { before: row.status, after: 'archived' },
      });
    });
    return { ...toItem(row), status: 'archived' };
  }

  private async getSession(id: string): Promise<SessionRow> {
    const row = await this.prisma.session.findUnique({
      where: { id },
      include: {
        user: { select: { email: true } },
        _count: { select: { messages: true, tasks: true } },
      },
    });
    if (!row) throw new NotFoundException('session_not_found');
    return row;
  }
}
