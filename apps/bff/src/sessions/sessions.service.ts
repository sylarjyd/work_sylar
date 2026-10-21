import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type {
  CreateSessionRequest,
  MessageDto,
  SessionSummary,
} from '@ai-office/shared';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<SessionSummary[]> {
    // 归档会话对普通用户不可见。
    const rows = await this.prisma.session.findMany({
      where: { tenantId, userId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      model: s.model ?? null,
    }));
  }

  async create(
    tenantId: string,
    userId: string,
    req: CreateSessionRequest,
  ): Promise<SessionSummary> {
    const s = await this.prisma.session.create({
      data: { tenantId, userId, title: req.title ?? '新会话' },
    });
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      model: s.model ?? null,
    };
  }

  /**
   * 校验会话归属（tenant 强制行级隔离，上游 §7）：非本租户/用户或已归档一律 404，不泄露存在性。
   */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: { not: 'archived' } },
    });
    if (!s) throw new NotFoundException('session_not_found');
  }

  async messages(sessionId: string, tenantId: string, userId: string): Promise<MessageDto[]> {
    await this.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      role: m.role as MessageDto['role'],
      content: m.content,
      seq: m.seq,
    }));
  }
}
