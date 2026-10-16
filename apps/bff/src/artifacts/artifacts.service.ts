import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { ArtifactDto, ArtifactRef } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { ARTIFACT_STORAGE, type ArtifactStorage } from './storage';

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
