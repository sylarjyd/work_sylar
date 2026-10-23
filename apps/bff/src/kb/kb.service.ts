import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  KbBaseDto,
  KbBaseInput,
  KbBasePatch,
  KbDocDto,
  KbSearchHit,
  KbDocStatus,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';

const INGEST_TIMEOUT_MS = 30_000;
const MAX_BASE_NAME = 60;
const MAX_BASE_DESCRIPTION = 500;

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

export interface RemoveBaseResult {
  name: string;
  deletedDocs: number;
  storageKeys: string[];
}

export interface RemoveDocResult {
  filename: string;
  storageKey: string;
}

/** 知识库：所有读写按 tenantId + userId 做行级隔离；文档绑定到知识库。 */
@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cfg: KbIngestConfig = {},
  ) {}

  async listBases(tenantId: string, userId: string): Promise<KbBaseDto[]> {
    const [bases, groups] = await Promise.all([
      this.prisma.knowledgeBase.findMany({
        where: { tenantId, userId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.kbDoc.groupBy({
        by: ['knowledgeBaseId', 'status'],
        where: { tenantId, userId },
        _count: { _all: true },
        _sum: { chunkCount: true, size: true },
      }),
    ]);
    const stats = new Map<string, KbBaseDto>();
    for (const base of bases) {
      stats.set(base.id, {
        id: base.id,
        name: base.name,
        description: base.description,
        docCount: 0,
        readyCount: 0,
        pendingCount: 0,
        failedCount: 0,
        chunkCount: 0,
        totalBytes: 0,
        createdAt: base.createdAt.toISOString(),
        updatedAt: base.updatedAt.toISOString(),
      });
    }
    for (const g of groups) {
      if (!g.knowledgeBaseId) continue;
      const item = stats.get(g.knowledgeBaseId);
      if (!item) continue;
      const count = g._count._all;
      item.docCount += count;
      if (g.status === 'ready') item.readyCount += count;
      else if (g.status === 'pending') item.pendingCount += count;
      else if (g.status === 'failed') item.failedCount += count;
      item.chunkCount += g._sum.chunkCount ?? 0;
      item.totalBytes += g._sum.size ?? 0;
    }
    return [...stats.values()];
  }

  async createBase(tenantId: string, userId: string, input: KbBaseInput): Promise<KbBaseDto> {
    const name = parseBaseName(input?.name);
    const description = parseBaseDescription(input?.description ?? '');
    try {
      const row = await this.prisma.knowledgeBase.create({
        data: { tenantId, userId, name, description },
      });
      return toBaseDto(row);
    } catch (err) {
      throw mapBaseWriteError(err);
    }
  }

  async updateBase(
    id: string,
    tenantId: string,
    userId: string,
    patch: KbBasePatch,
  ): Promise<KbBaseDto> {
    await this.assertBaseOwned(id, tenantId, userId);
    const data: { name?: string; description?: string } = {};
    if (patch && Object.hasOwn(patch, 'name')) data.name = parseBaseName(patch.name);
    if (patch && Object.hasOwn(patch, 'description')) {
      data.description = parseBaseDescription(patch.description ?? '');
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_kb_base_patch');
    try {
      const row = await this.prisma.knowledgeBase.update({ where: { id }, data });
      return toBaseDto(row);
    } catch (err) {
      throw mapBaseWriteError(err);
    }
  }

  async assertBaseOwned(id: string, tenantId: string, userId: string): Promise<void> {
    const row = await this.prisma.knowledgeBase.findFirst({
      where: { id, tenantId, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('kb_base_not_found');
  }

  async listDocs(baseId: string, tenantId: string, userId: string): Promise<KbDocDto[]> {
    await this.assertBaseOwned(baseId, tenantId, userId);
    const rows = await this.prisma.kbDoc.findMany({
      where: { knowledgeBaseId: baseId, tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async createDoc(baseId: string, input: CreateDocInput): Promise<KbDocDto> {
    const base = await this.prisma.knowledgeBase.findFirst({
      where: { id: baseId, tenantId: input.tenantId, userId: input.userId },
      select: { id: true },
    });
    if (!base) throw new NotFoundException('kb_base_not_found');
    const row = await this.prisma.kbDoc.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        knowledgeBaseId: baseId,
        filename: input.filename,
        mime: input.mime,
        size: input.size,
        storageKey: input.storageKey,
        status: 'pending',
      },
    });
    return toDto(row);
  }

  /**
   * 删除知识库：事务内级联删文档/切片，并把该库从未绑定助手列表中移除；
   * 返回对象存储 key，由调用方在提交后清理（失败不影响删除结果）。
   */
  async removeBase(id: string, tenantId: string, userId: string): Promise<RemoveBaseResult> {
    return this.prisma.$transaction(async (tx) => {
      const base = await tx.knowledgeBase.findFirst({
        where: { id, tenantId, userId },
        select: { id: true, name: true },
      });
      if (!base) throw new NotFoundException('kb_base_not_found');
      const docs = await tx.kbDoc.findMany({
        where: { knowledgeBaseId: id, tenantId, userId },
        select: { storageKey: true },
      });
      await tx.$executeRaw`
        UPDATE "Assistant"
        SET "kbIds" = array_remove("kbIds", ${id})
        WHERE "tenantId" = ${tenantId} AND ${id} = ANY("kbIds")
      `;
      await tx.knowledgeBase.delete({ where: { id } });
      return {
        name: base.name,
        deletedDocs: docs.length,
        storageKeys: docs.map((d) => d.storageKey),
      };
    });
  }

  async removeDoc(
    baseId: string,
    docId: string,
    tenantId: string,
    userId: string,
  ): Promise<RemoveDocResult> {
    const doc = await this.prisma.kbDoc.findFirst({
      where: { id: docId, knowledgeBaseId: baseId, tenantId, userId },
      select: { filename: true, storageKey: true },
    });
    if (!doc) throw new NotFoundException('kb_doc_not_found');
    // 级联删除切片由外键 onDelete: Cascade 承担；显式删 doc 即可。
    await this.prisma.kbDoc.delete({ where: { id: docId } });
    return { filename: doc.filename, storageKey: doc.storageKey };
  }

  /**
   * 向量检索：按 tenant+user 过滤，HNSW 余弦距离升序取 topK；相似度 = 1 - 距离。
   * kbIds 为助手绑定的知识库范围；空/缺省表示全部。仍叠加 tenant/user 条件，
   * 越权 ID 不会泄露数据。
   */
  async search(
    tenantId: string,
    userId: string,
    vector: number[],
    topK: number,
    kbIds?: string[],
  ): Promise<KbSearchHit[]> {
    const lit = toVectorLiteral(vector);
    const kbFilter =
      kbIds && kbIds.length > 0
        ? Prisma.sql`AND d."knowledgeBaseId" = ANY(${kbIds}::text[])`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { docName: string; seq: number; dist: number; text: string }[]
    >`
      SELECT d."filename" AS "docName", c."seq", c."text", (c."vector" <=> ${lit}::vector) AS "dist"
      FROM "KbChunk" c JOIN "KbDoc" d ON d."id" = c."docId"
      WHERE c."tenantId" = ${tenantId} AND c."userId" = ${userId}
        AND d."tenantId" = ${tenantId} AND d."userId" = ${userId}
      ${kbFilter}
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

function parseBaseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_kb_name');
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_BASE_NAME) {
    throw new BadRequestException('invalid_kb_name');
  }
  return name;
}

function parseBaseDescription(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_BASE_DESCRIPTION) {
    throw new BadRequestException('invalid_kb_description');
  }
  return raw;
}

function mapBaseWriteError(err: unknown): unknown {
  if (err instanceof ConflictException) return err;
  const e = err as { code?: string };
  if (e?.code === 'P2002') return new ConflictException('kb_base_exists');
  return err;
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function toBaseDto(row: {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}): KbBaseDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    docCount: 0,
    readyCount: 0,
    pendingCount: 0,
    failedCount: 0,
    chunkCount: 0,
    totalBytes: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDto(row: {
  id: string;
  knowledgeBaseId: string | null;
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
    // 回填脚本保证存量文档已归类；空值仅可能在回填前出现，DTO 以空串兜底。
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
