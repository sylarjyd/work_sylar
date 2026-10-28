import { Controller, Get, Logger, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from '../attachments/attachments.service';

/** 文件名进响应头前清洗：只保留可打印 ASCII，另附 RFC 5987 的 UTF-8 名。 */
function inlineContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 运营端附件预览：管理员按会话排查时需要在浏览器里直接打开用户上传的附件。
 * 附件按 id 全局读取（不做 tenant/user 过滤），因此必须挂在 AdminGuard 后面并留审计。
 */
@Controller('api/admin/attachments')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAttachmentsController {
  private readonly logger = new Logger(AdminAttachmentsController.name);

  constructor(
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/content')
  async content(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let result: Awaited<ReturnType<AttachmentsService['getContentForAdmin']>>;
    try {
      result = await this.attachments.getContentForAdmin(id);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'attachment_not_found' });
        return;
      }
      this.logger.error(`运营端读取附件 ${id} 失败: ${(err as Error).message}`);
      reply.status(502).send({ error: 'object_unavailable' });
      return;
    }
    await this.audit.bestEffort(actorOf(user, req), {
      action: 'attachment.view',
      targetType: 'attachment',
      targetId: id,
      summary: { filename: result.filename, mime: result.mime },
    });
    reply.header('content-type', result.mime);
    reply.header('content-length', String(result.buffer.length));
    reply.header('content-disposition', inlineContentDisposition(result.filename));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, max-age=60');
    await reply.send(result.buffer);
  }
}
