import { randomUUID } from 'node:crypto';
import {
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
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import type { KbDocDto } from '@ai-office/shared';
import { KbService } from './kb.service';
import { sanitizeFilename } from './filename';
import { KB_STORAGE, type KbStorage } from './storage';
import { Inject } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

const ALLOWED_EXT = ['txt', 'md', 'csv', 'docx', 'xlsx', 'pdf'];

@Controller('api/kb/docs')
@UseGuards(JwtGuard)
export class KbController {
  private readonly logger = new Logger(KbController.name);

  constructor(
    private readonly kb: KbService,
    @Inject(KB_STORAGE) private readonly storage: KbStorage,
  ) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<KbDocDto[]> {
    return this.kb.list(user.tenantId, user.sub);
  }

  @Post()
  async upload(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let file: MultipartFile | undefined;
    try {
      file = await req.file();
    } catch {
      // @fastify/multipart 在超限时抛错（RequestFileTooLargeError 等）。
      reply.status(413).send({ error: 'file_too_large' });
      return;
    }
    if (!file) {
      reply.status(400).send({ error: 'missing_file' });
      return;
    }
    const ext = file.filename.includes('.') ? file.filename.split('.').pop()!.toLowerCase() : '';
    if (!ALLOWED_EXT.includes(ext)) {
      // 需要排空流，否则连接悬挂。
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
    const mime = file.mimetype || 'application/octet-stream';
    const storageKey = `kb/${user.tenantId}/${user.sub}/${randomUUID()}/${sanitizeFilename(file.filename)}`;
    await this.storage.putObject(storageKey, buffer, mime);
    const doc = await this.kb.create({
      tenantId: user.tenantId,
      userId: user.sub,
      filename: file.filename,
      mime,
      size: buffer.length,
      storageKey,
    });
    // 异步摄取：不阻塞上传响应，前端轮询 status；失败置 failed + error。
    void this.kb
      .ingest({ id: doc.id, tenantId: user.tenantId, userId: user.sub, filename: doc.filename, mime: doc.mime, storageKey })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`kb doc ${doc.id} 摄取失败: ${msg}`);
        await this.kb.markFailed(doc.id, user.tenantId, user.sub, msg);
      });
    reply.status(202).send(doc);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      await this.kb.remove(id, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'doc_not_found' });
        return;
      }
      throw err;
    }
    reply.status(204).send();
  }
}
