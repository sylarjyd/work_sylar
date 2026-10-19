import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { KbDocDto, KbSearchHit, KbDocStatus } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';

const INGEST_TIMEOUT_MS = 30_000;

export interface KbIngestConfig {
  runtimeUrl?: string;
  runtimeToken?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateDocInput {
  tenantId: string;
  userId: string;
  filename: string;
  mime: string;
  size: number;
  storageKey: string;
}

/** 摄取所需的最小文档投影（避免把整行塞进编排）。 */
export type IngestTarget = Pick<
  CreateDocInput,
  'tenantId' | 'userId' | 'filename' | 'mime' | 'storageKey'
> & { id: string };

@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cfg: KbIngestConfig = {},
  ) {}

  async create(input: CreateDocInput): Promise<KbDocDto> {
    const row = await this.prisma.kbDoc.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        filename: input.filename,
        mime: input.mime,
        size: input.size,
        storageKey: input.storageKey,
        status: 'pending',
      },
    });
    return toDto(row);
  }

  async list(tenantId: string, userId: string): Promise<KbDocDto[]> {
    const rows = await this.prisma.kbDoc.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async remove(id: string, tenantId: string, userId: string): Promise<void> {
    const doc = await this.prisma.kbDoc.findFirst({ where: { id, tenantId, userId } });
    if (!doc) throw new NotFoundException('doc_not_found');
    // 级联删除切片由外键 onDelete: Cascade 承担；显式删 doc 即可。
    await this.prisma.kbDoc.delete({ where: { id } });
  }

  /** 向量检索：按 tenant+user 过滤，HNSW 余弦距离升序取 topK；相似度 = 1 - 距离。 */
  async search(
    tenantId: string,
    userId: string,
    vector: number[],
    topK: number,
  ): Promise<KbSearchHit[]> {
    const lit = toVectorLiteral(vector);
    const rows = await this.prisma.$queryRaw<
      { docName: string; seq: number; dist: number; text: string }[]
    >`
      SELECT d."filename" AS "docName", c."seq", c."text", (c."vector" <=> ${lit}::vector) AS "dist"
      FROM "KbChunk" c JOIN "KbDoc" d ON d."id" = c."docId"
      WHERE c."tenantId" = ${tenantId} AND c."userId" = ${userId}
      ORDER BY c."vector" <=> ${lit}::vector
      LIMIT ${topK}
    `;
    return rows.map((r) => ({
      docName: r.docName,
      seq: Number(r.seq),
      score: 1 - Number(r.dist),
      text: r.text,
    }));
  }

  /**
   * 摄取编排：调 runtime /kb/ingest 取切片（含向量），写 KbChunk（向量走原始 SQL），
   * 并把 doc 置 ready。任一步失败抛错，由调用方置 failed。
   */
  async ingest(
    target: IngestTarget,
    chunkConfig?: { chunkSize: number; chunkOverlap: number },
  ): Promise<void> {
    // 归属校验：切片与状态一律针对「属于该 tenant/user 的文档」写入，
    // 杜绝调用方传入错配的 tenant/user 造成跨租户写入（与 remove 同款前置校验）。
    const owned = await this.prisma.kbDoc.findFirst({
      where: { id: target.id, tenantId: target.tenantId, userId: target.userId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('doc_not_found');

    const doFetch = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.runtimeUrl ?? process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const token = this.cfg.runtimeToken ?? process.env.AGENT_RUNTIME_TOKEN;
    let res: Response;
    try {
      res = await doFetch(`${base}/kb/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-agent-runtime-token': token } : {}),
        },
        body: JSON.stringify({
          storageKey: target.storageKey,
          filename: target.filename,
          mime: target.mime,
          ...(chunkConfig ?? {}),
        }),
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('runtime_unreachable');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`runtime_http_${res.status}`);
    }
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      chunks?: { seq: number; text: string; vector: number[] }[];
    };
    if (!data.ok) throw new Error(data.error ?? 'ingest_failed');
    const chunks = data.chunks ?? [];

    await this.prisma.$transaction(async (tx) => {
      // 幂等：重摄取先清掉旧切片，避免残留重复。
      await tx.kbChunk.deleteMany({ where: { docId: target.id } });
      for (const c of chunks) {
        await tx.$executeRaw`
          INSERT INTO "KbChunk" ("id", "docId", "tenantId", "userId", "seq", "text", "vector", "createdAt")
          VALUES (${randomUUID()}, ${target.id}, ${target.tenantId}, ${target.userId}, ${c.seq}, ${c.text}, ${toVectorLiteral(c.vector)}::vector, NOW())
        `;
      }
      await tx.kbDoc.update({
        where: { id: target.id },
        data: { status: 'ready', chunkCount: chunks.length, error: null },
      });
    });
  }

  /** 摄取失败收尾：置 failed + error（best-effort，落库失败不再抛）；按 tenant/user 限定，避免越权改动他人文档。 */
  async markFailed(id: string, tenantId: string, userId: string, error: string): Promise<void> {
    try {
      await this.prisma.kbDoc.updateMany({
        where: { id, tenantId, userId },
        data: { status: 'failed', error },
      });
    } catch (err) {
      this.logger.error(`kb doc ${id} 置 failed 失败: ${(err as Error).message}`);
    }
  }
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function toDto(row: {
  id: string;
  filename: string;
  mime: string;
  size: number;
  status: string;
  chunkCount: number;
  error: string | null;
  createdAt: Date;
}): KbDocDto {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    status: row.status as KbDocStatus,
    chunkCount: row.chunkCount,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}
