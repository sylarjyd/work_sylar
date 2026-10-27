import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AdminQaCacheListDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { isQaCacheHash, QaCacheService } from '../qa-cache/qa-cache.service';
import { parsePage } from './admin.util';

/** 运营端问答缓存：只展示未过期条目，删除留审计。 */
@Injectable()
export class AdminQaCacheService {
  private readonly logger = new Logger(AdminQaCacheService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: QaCacheService,
  ) {}

  async list(query: Record<string, unknown>): Promise<AdminQaCacheListDto> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    // 缓存命令失败（连接断开/超时）与未配置同等处理：运营端只看到 503。
    let result: Awaited<ReturnType<QaCacheService['list']>>;
    try {
      result = await this.cache.list({ offset: skip, limit: take });
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.warn(`读取问答缓存列表失败: ${(err as Error).message}`);
      throw new ServiceUnavailableException('cache_unavailable');
    }

    const sessionIds = [...new Set(result.items.map((item) => item.sessionId))];
    const sessions = sessionIds.length
      ? await this.prisma.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true, user: { select: { email: true } } },
        })
      : [];
    const byId = new Map(sessions.map((session) => [session.id, session]));

    return {
      items: result.items.map((item) => {
        const session = byId.get(item.sessionId);
        return {
          hash: item.hash,
          userId: item.userId,
          userEmail: session?.user.email ?? item.userId,
          sessionId: item.sessionId,
          sessionTitle: session?.title ?? item.sessionId,
          question: item.question,
          answer: item.answer,
          createdAt: new Date(item.createdAt).toISOString(),
          expiresAt: new Date(item.expiresAt).toISOString(),
        };
      }),
      total: result.total,
      page,
      pageSize,
    };
  }

  async remove(hash: string, actor: AdminActor): Promise<void> {
    if (!isQaCacheHash(hash)) throw new BadRequestException('invalid_hash');
    let entry: Awaited<ReturnType<QaCacheService['get']>>;
    try {
      entry = await this.cache.get(hash);
      await this.cache.remove(hash);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.warn(`删除问答缓存失败 hash=${hash}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('cache_unavailable');
    }
    await this.audit.bestEffort(actor, {
      action: 'qa_cache.delete',
      targetType: 'qa_cache',
      targetId: hash,
      summary: {
        userId: entry?.userId ?? null,
        sessionId: entry?.sessionId ?? null,
      },
    });
  }
}
