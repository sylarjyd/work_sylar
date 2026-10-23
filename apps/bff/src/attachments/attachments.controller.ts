import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import {
  ATTACHMENT_SPECS,
  attachmentKindFor,
  type AttachmentDto,
  type AttachmentKind,
} from '@ai-office/shared';
import { AttachmentsService } from './attachments.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

/** 全局 multipart 上限按知识库的 10MiB 配置；聊天附件允许 30MiB 视频，需在路由级放宽。 */
const MAX_ATTACHMENT_BYTES = Math.max(
  ...Object.values(ATTACHMENT_SPECS).map((spec) => spec.maxBytes),
);

function inlineContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 聊天附件：上传、预览与撤回。内容按 tenant/user 隔离，不做公开直链。 */
@Controller('api/attachments')
@UseGuards(JwtGuard)
export class AttachmentsController {
  private readonly logger = new Logger(AttachmentsController.name);

  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  async upload(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let file: MultipartFile | undefined;
    try {
      file = await req.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } });
    } catch (err) {
      // 只有 multipart 自身的限额错误才是 413；非 multipart 请求等属于请求格式错误。
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
        reply.status(413).send({ error: 'file_too_large' });
      } else {
        reply.status(400).send({ error: 'invalid_upload' });
      }
      return;
    }
    if (!file) {
      reply.status(400).send({ error: 'missing_file' });
      return;
    }
    const kind: AttachmentKind | null = attachmentKindFor(file.filename, file.mimetype);
    if (!kind) {
      // 必须排空流，否则连接悬挂。
      await file.toBuffer().catch(() => undefined);
      reply.status(400).send({ error: 'unsupported_type' });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      reply.status(413).send({ error: 'file_too_large' });
      return;
    }
    if (buffer.length > ATTACHMENT_SPECS[kind].maxBytes) {
      reply.status(413).send({ error: 'file_too_large' });
      return;
    }
    const dto: AttachmentDto = await this.attachments.create(user.tenantId, user.sub, {
      filename: file.filename,
      kind,
      mime: file.mimetype,
      size: buffer.length,
      buffer,
    });
    reply.status(201).send(dto);
  }

  /** 内联回放：前端用它渲染图片/音频/视频预览；nosniff 防止伪装内容被当作脚本执行。 */
  @Get(':id/content')
  async content(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let result: { buffer: Buffer; mime: string; filename: string };
    try {
      result = await this.attachments.getContent(id, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'attachment_not_found' });
        return;
      }
      this.logger.error(`附件 ${id} 读取失败: ${(err as Error).message}`);
      reply.status(502).send({ error: 'object_unavailable' });
      return;
    }
    reply.header('content-type', result.mime);
    reply.header('content-length', String(result.buffer.length));
    reply.header('content-disposition', inlineContentDisposition(result.filename));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, max-age=300');
    await reply.send(result.buffer);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      await this.attachments.remove(id, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'attachment_not_found' });
        return;
      }
      if (err instanceof ConflictException) {
        reply.status(409).send({ error: 'attachment_in_use' });
        return;
      }
      throw err;
    }
    reply.status(204).send();
  }
}
