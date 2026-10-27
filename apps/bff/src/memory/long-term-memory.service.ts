import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

/** 相关度阈值：bge-large-zh 上相关中文句通常 ≥ 0.5，0.4 能过滤噪声又不漏召。 */
export const MEMORY_SCORE_THRESHOLD = 0.4;
export const MEMORY_MAX_PER_USER = 500;
export const MEMORY_CONTENT_MAX_CHARS = 500;

export interface MemoryHit {
  id: string;
  content: string;
  score: number;
}

/** NFKC 归一 + 折叠空白 + 小写：同一事实的不同排版视为同一条。 */
export function normalizeMemoryContent(content: string): string {
  return content.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 内容指纹：归一化后再去掉全部空白，让「喜欢简洁」与「喜欢 简洁」这类
 * 中文排版差异命中同一唯一键。
 */
export function memoryHash(content: string): string {
  return createHash('sha256')
    .update(normalizeMemoryContent(content).replace(/\s+/g, ''))
    .digest('hex');
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * 长期记忆：SQL 全部强制 tenantId + userId 过滤，参数绑定，
 * 不存在跨用户读取路径；写入按 hash 去重，每用户只保留最近 500 条。
 */
@Injectable()
export class LongTermMemoryService {
  private readonly logger = new Logger(LongTermMemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async retrieve(params: {
    tenantId: string;
    userId: string;
    vector: number[];
    topK: number;
  }): Promise<MemoryHit[]> {
    const { tenantId, userId, vector, topK } = params;
    if (vector.length === 0 || topK <= 0) return [];
    const lit = toVectorLiteral(vector);
    const rows = await this.prisma.$queryRaw<
      { id: string; content: string; score: number }[]
    >`
      SELECT "id", "content", 1 - ("vector" <=> ${lit}::vector) AS "score"
      FROM "UserMemory"
      WHERE "tenantId" = ${tenantId} AND "userId" = ${userId}
        AND 1 - ("vector" <=> ${lit}::vector) >= ${MEMORY_SCORE_THRESHOLD}
      ORDER BY "vector" <=> ${lit}::vector
      LIMIT ${topK}
    `;
    const hits = rows.map((r) => ({
      id: r.id,
      content: r.content,
      score: Number(r.score),
    }));
    if (hits.length > 0) {
      await this.touch(hits.map((h) => h.id), tenantId, userId);
    }
    return hits;
  }

  async remember(params: {
    tenantId: string;
    userId: string;
    sessionId: string;
    items: { content: string; vector: number[] }[];
  }): Promise<void> {
    const { tenantId, userId, sessionId, items } = params;
    const seen = new Set<string>();
    for (const item of items) {
      const content = item.content.replace(/\s+/g, ' ').trim().slice(0, MEMORY_CONTENT_MAX_CHARS);
      if (content === '' || item.vector.length === 0) continue;
      const hash = memoryHash(content);
      if (seen.has(hash)) continue;
      seen.add(hash);
      // 长期记忆是增强能力：单条写入失败只记日志，不能让整批中断。
      try {
        await this.prisma.$executeRaw`
          INSERT INTO "UserMemory" ("id", "tenantId", "userId", "sessionId", "content", "hash", "vector", "createdAt")
          VALUES (${randomUUID()}, ${tenantId}, ${userId}, ${sessionId}, ${content}, ${hash}, ${toVectorLiteral(item.vector)}::vector, NOW())
          ON CONFLICT ("tenantId", "userId", "hash") DO NOTHING
        `;
      } catch (err) {
        this.logger.warn(`写入长期记忆失败（tenant=${tenantId}）: ${(err as Error).message}`);
      }
    }
    await this.prune(tenantId, userId);
  }

  /** 只保留该用户最近 MEMORY_MAX_PER_USER 条；失败只记日志。 */
  private async prune(tenantId: string, userId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM "UserMemory"
        WHERE "tenantId" = ${tenantId} AND "userId" = ${userId}
          AND "id" NOT IN (
            SELECT "id" FROM "UserMemory"
            WHERE "tenantId" = ${tenantId} AND "userId" = ${userId}
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT ${MEMORY_MAX_PER_USER}
          )
      `;
    } catch (err) {
      this.logger.warn(`修剪长期记忆失败（tenant=${tenantId}）: ${(err as Error).message}`);
    }
  }

  /** 召回即视为使用：lastUsedAt 只做观测，失败忽略。 */
  private async touch(ids: string[], tenantId: string, userId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "UserMemory" SET "lastUsedAt" = NOW()
        WHERE "id" = ANY(${ids}::text[])
          AND "tenantId" = ${tenantId} AND "userId" = ${userId}
      `;
    } catch (err) {
      this.logger.warn(`更新记忆使用时间失败: ${(err as Error).message}`);
    }
  }
}
