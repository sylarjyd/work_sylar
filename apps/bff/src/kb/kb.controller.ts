import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import type { KbBaseDto, KbBaseInput, KbBasePatch, KbDeleteResultDto, KbDocDto } from '@ai-office/shared';
import { KbService } from './kb.service';
import { sanitizeFilename } from './filename';
import { KB_STORAGE, type KbStorage } from './storage';
import { cleanupStorageObjects } from './storage-cleanup';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { SettingsService } from '../settings/settings.service';

const ALLOWED_EXT = ['txt', 'md', 'csv', 'docx', 'xlsx', 'pdf'];

/** 客户端知识库：库 CRUD + 库内文档上传/删除；所有操作按 JWT 中的 tenant/user 隔离。 */
@Controller('api/kb/bases')
@UseGuards(JwtGuard)
export class KbController {
  private readonly logger = new Logger(KbController.name);

  constructor(
    private readonly kb: KbService,
    @Inject(KB_STORAGE) private readonly storage: KbStorage,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  listBases(@CurrentUser() user: JwtPayload): Promise<KbBaseDto[]> {
    return this.kb.listBases(user.tenantId, user.sub);
  }

  @Post()
  createBase(
    @CurrentUser() user: JwtPayload,
    @Body() body: KbBaseInput,
  ): Promise<KbBaseDto> {
    return this.kb.createBase(user.tenantId, user.sub, body);
  }

  @Patch(':id')
  updateBase(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: KbBasePatch,
  ): Promise<KbBaseDto> {
    return this.kb.updateBase(id, user.tenantId, user.sub, body);
  }

  @Delete(':id')
  async removeBase(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let result: Awaited<ReturnType<KbService['removeBase']>>;
    try {
      result = await this.kb.removeBase(id, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'kb_base_not_found' });
        return;
      }
      throw err;
    }
    const { failed } = await cleanupStorageObjects(this.storage, result.storageKeys, this.logger);
    const dto: KbDeleteResultDto = { deletedDocs: result.deletedDocs, cleanupFailed: failed.length };
    reply.status(200).send(dto);
  }

  @Get(':id/docs')
  async listDocs(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      reply.send(await this.kb.listDocs(id, user.tenantId, user.sub));
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'kb_base_not_found' });
        return;
      }
      throw err;
    }
  }

  @Post(':id/docs')
  async upload(
    @CurrentUser() user: JwtPayload,
    @Param('id') baseId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // 先校验归属再消费 multipart：越权请求不必读完整个文件。
    try {
      await this.kb.assertBaseOwned(baseId, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'kb_base_not_found' });
        return;
      }
      throw err;
    }

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
    const storageKey = `kb/${user.tenantId}/${user.sub}/${baseId}/${randomUUID()}/${sanitizeFilename(file.filename)}`;
    await this.storage.putObject(storageKey, buffer, mime);
    let doc: KbDocDto;
    try {
      doc = await this.kb.createDoc(baseId, {
        tenantId: user.tenantId,
        userId: user.sub,
        filename: file.filename,
        mime,
        size: buffer.length,
        storageKey,
      });
    } catch (err) {
      // 记录没建成，对象就是孤儿：best-effort 清掉，避免 MinIO 越积越多。
      await cleanupStorageObjects(this.storage, [storageKey], this.logger);
      throw err;
    }
    // 配置读取放进异步摄取链：读失败降级为 undefined（runtime 回落到 env/默认值），
    // 不能因调参配置读取失败把已成功的上传变成 500、留下永不摄取的 pending 文档。
    void this.settings
      .getKbConfig()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`读取 KB 切分配置失败，使用默认值: ${msg}`);
        return undefined;
      })
      .then((chunkConfig) =>
        this.kb.ingest(
          {
            id: doc.id,
            tenantId: user.tenantId,
            userId: user.sub,
            filename: doc.filename,
            mime: doc.mime,
            storageKey,
          },
          chunkConfig,
        ),
      )
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`kb doc ${doc.id} 摄取失败: ${msg}`);
        await this.kb.markFailed(doc.id, user.tenantId, user.sub, msg);
      });
    reply.status(202).send(doc);
  }

  @Delete(':id/docs/:docId')
  async removeDoc(
    @CurrentUser() user: JwtPayload,
    @Param('id') baseId: string,
    @Param('docId') docId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let result: Awaited<ReturnType<KbService['removeDoc']>>;
    try {
      result = await this.kb.removeDoc(baseId, docId, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'kb_doc_not_found' });
        return;
      }
      throw err;
    }
    const { failed } = await cleanupStorageObjects(this.storage, [result.storageKey], this.logger);
    const dto: KbDeleteResultDto = { deletedDocs: 1, cleanupFailed: failed.length };
    reply.status(200).send(dto);
  }
}
