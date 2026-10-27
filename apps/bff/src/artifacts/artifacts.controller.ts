import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import type { ArtifactDto } from '@ai-office/shared';
import { ArtifactService } from './artifacts.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  text: 'text/plain; charset=utf-8',
};

/** 兼容非 ASCII 文件名：ASCII 回退 + RFC 5987 的 filename*。 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 产物入口：列表与下载均按 tenant/user 校验归属；下载走流式代理，不在 BFF 落盘。 */
@Controller('api')
@UseGuards(JwtGuard)
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactService) {}

  @Get('sessions/:id/artifacts')
  list(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<ArtifactDto[]> {
    return this.artifacts.list(id, user.tenantId, user.sub);
  }

  @Get('artifacts/:id/download')
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let result: { filename: string; kind: string; stream: Readable };
    try {
      result = await this.artifacts.getForDownload(id, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'not_found' });
        return;
      }
      // DB 有行但对象缺失（或对象存储不可达）：回 502，区分于「不存在」。
      reply.status(502).send({ error: 'object_unavailable' });
      return;
    }
    reply.header('content-type', MIME[result.kind] ?? 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(result.filename));
    // 客户端中途断开时主动销毁上游 S3 流，否则连接/句柄会挂到对象读完才释放。
    reply.raw.once('close', () => result.stream.destroy());
    await reply.send(result.stream);
  }
}
