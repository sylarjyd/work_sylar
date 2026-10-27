import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { ArtifactDto, ArtifactRef } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { ARTIFACT_STORAGE, type ArtifactStorage } from './storage';

const KINDS = ['docx', 'xlsx', 'pptx', 'text'] as const;

/**
 * 校验 runtime SSE 传来的产物引用：runtime 是独立进程、走 HTTP 送达，不能信任其 payload。
 * 不合规即抛错（由调用方 safeRecordArtifact 吞掉并记日志），既不落库也不打断 SSE 流。
 * storageKey 必须落在本租户本次运行的 key 前缀内，杜绝越权指向他人对象。
 */
function assertValidRef(ref: ArtifactRef, tenantId: string, runId: string): void {
  const r = ref as unknown as Record<string, unknown>;
  if (typeof r.filename !== 'string' || r.filename.trim() === '') throw new Error('invalid_filename');
  if (!KINDS.includes(r.kind as (typeof KINDS)[number])) throw new Error('invalid_kind');
  if (!Number.isInteger(r.size) || (r.size as number) < 0) throw new Error('invalid_size');
  if (
    typeof r.storageKey !== 'string' ||
    !r.storageKey.startsWith(`artifacts/${tenantId}/${runId}/`)
  ) {
    throw new Error('invalid_storage_key');
  }
}

@Injectable()
export class ArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage,
  ) {}

  /** 落库一条产物；version 按 (sessionId, filename) 递增，同名重生成即升版。 */
  async record(
    runId: string,
    sessionId: string,
    tenantId: string,
    ref: ArtifactRef,
  ): Promise<void> {
    assertValidRef(ref, tenantId, runId);
    const agg = await this.prisma.artifact.aggregate({
      where: { sessionId, filename: ref.filename },
      _max: { version: true },
    });
    const version = (agg._max.version ?? 0) + 1;
    await this.prisma.artifact.create({
      data: {
        tenantId,
        sessionId,
        runId,
        kind: ref.kind,
        filename: ref.filename,
        storageKey: ref.storageKey,
        size: ref.size,
        version,
      },
    });
  }

  async list(sessionId: string, tenantId: string, userId: string): Promise<ArtifactDto[]> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.artifact.findMany({
      where: { sessionId, tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((a) => ({
      id: a.id,
      kind: a.kind as ArtifactDto['kind'],
      filename: a.filename,
      size: a.size,
      version: a.version,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  /** 校验归属并取对象流：先按租户取行，再校验会话归属（与 list 一致）；DB 无行/非本用户 → 404。 */
  async getForDownload(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<{ filename: string; kind: string; stream: Readable }> {
    const a = await this.prisma.artifact.findFirst({ where: { id, tenantId } });
    if (!a) throw new NotFoundException('artifact_not_found');
    await this.sessions.assertOwned(a.sessionId, tenantId, userId);
    const stream = await this.storage.getObjectStream(a.storageKey);
    return { filename: a.filename, kind: a.kind, stream };
  }
}
