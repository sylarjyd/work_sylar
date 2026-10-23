import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ATTACHMENT_SPECS,
  attachmentKindFor,
  attachmentMimeFor,
  type AttachmentDto,
  type AttachmentKind,
  type ChatAttachment,
  type ChatMessage,
  type ChatRole,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { sanitizeFilename } from '../kb/filename';
import { ATTACHMENT_STORAGE, type AttachmentStorage } from './attachments.storage';

/** 单次运行携带附件内容的总预算：超出时只保留最新消息，历史附件降级为文件名提示。 */
export const MAX_RUN_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export interface UploadedAttachment {
  filename: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  buffer: Buffer;
}

/** 事务内绑定到消息的附件（含仅服务端可见的存储 Key）。 */
export interface PreparedAttachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  storageKey: string;
}

export interface PreparedMessage {
  role: ChatRole;
  content: string;
  attachments: PreparedAttachment[];
}

interface AttachmentRow {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  storageKey: string;
  sessionId: string | null;
  messageId: string | null;
  createdAt: Date;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ATTACHMENT_STORAGE) private readonly storage: AttachmentStorage,
  ) {}

  /**
   * 上传并落库。类别由文件名/MIME 共同判定，MIME 使用服务端规范值，
   * 不信任客户端声明（避免把 HTML 等伪装成图片回放）。
   */
  async create(tenantId: string, userId: string, input: UploadedAttachment): Promise<AttachmentDto> {
    const kind = attachmentKindFor(input.filename, input.mime);
    if (!kind) throw new BadRequestException('unsupported_type');
    const spec = ATTACHMENT_SPECS[kind];
    if (input.size > spec.maxBytes) throw new BadRequestException('file_too_large');
    const mime = attachmentMimeFor(input.filename, kind);
    const storageKey = `attachments/${tenantId}/${userId}/${randomUUID()}/${sanitizeFilename(input.filename)}`;
    await this.storage.putObject(storageKey, input.buffer, mime);
    try {
      const row = await this.prisma.attachment.create({
        data: {
          tenantId,
          userId,
          kind,
          filename: input.filename,
          mime,
          size: input.size,
          storageKey,
        },
      });
      return toDto(row, kind);
    } catch (err) {
      // 元数据落库失败时清掉对象，避免留下不可见的孤儿文件。
      await this.storage.deleteObject(storageKey).catch(() => undefined);
      throw err;
    }
  }

  /** 发送前校验：附件必须属于当前用户且尚未被任何消息占用。 */
  async listOwnedUnclaimed(
    ids: string[],
    tenantId: string,
    userId: string,
  ): Promise<PreparedAttachment[]> {
    const unique = [...new Set(ids)];
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: unique }, tenantId, userId, sessionId: null, messageId: null },
      select: {
        id: true,
        kind: true,
        filename: true,
        mime: true,
        size: true,
        storageKey: true,
      },
    });
    if (rows.length !== unique.length) throw new NotFoundException('attachment_not_found');
    const byId = new Map(rows.map((r) => [r.id, r]));
    return unique.map((id) => toPrepared(byId.get(id)!));
  }

  /** 撤回未发送附件：已绑定消息的附件不能删除，避免历史消息出现断链。 */
  async remove(id: string, tenantId: string, userId: string): Promise<void> {
    const row = await this.prisma.attachment.findFirst({
      where: { id, tenantId, userId },
      select: { id: true, storageKey: true, sessionId: true, messageId: true },
    });
    if (!row) throw new NotFoundException('attachment_not_found');
    if (row.sessionId || row.messageId) throw new ConflictException('attachment_in_use');
    await this.storage.deleteObject(row.storageKey).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`删除附件对象失败 ${row.id}: ${msg}`);
    });
    await this.prisma.attachment.delete({ where: { id: row.id } });
  }

  /** 预览/回放：按 tenant/user 校验后返回原始字节。 */
  async getContent(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; mime: string; filename: string }> {
    const row = await this.prisma.attachment.findFirst({
      where: { id, tenantId, userId },
      select: { id: true, storageKey: true, mime: true, filename: true },
    });
    if (!row) throw new NotFoundException('attachment_not_found');
    const buffer = await this.storage.getObjectBuffer(row.storageKey);
    return { buffer, mime: row.mime, filename: row.filename };
  }

  /**
   * 把已绑定消息的附件按预算补上 base64 内容。
   * 预算从最新消息倒序分配；最新消息必须完整可用，历史附件超出预算时仅保留元数据，
   * runtime 会以「附件未随本次运行发送」的文本提示模型，不会静默丢上下文。
   */
  async hydrateForRun(messages: PreparedMessage[]): Promise<ChatMessage[]> {
    const latest = messages.length - 1;
    const latestBytes = messages[latest]?.attachments.reduce((sum, a) => sum + a.size, 0) ?? 0;
    if (latestBytes > MAX_RUN_ATTACHMENT_BYTES) throw new BadRequestException('attachments_too_large');

    const out: ChatMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.attachments.length > 0 ? { attachments: [] as ChatAttachment[] } : {}),
    }));
    let budget = MAX_RUN_ATTACHMENT_BYTES;
    for (let i = messages.length - 1; i >= 0; i--) {
      const target = out[i].attachments;
      if (!target) continue;
      for (const a of messages[i].attachments) {
        const include = i === latest ? true : a.size <= budget;
        let data: string | undefined;
        if (include) {
          try {
            data = (await this.storage.getObjectBuffer(a.storageKey)).toString('base64');
            budget -= a.size;
          } catch (err) {
            // 最新消息的附件取不到属于实质性失败，让本次运行明确报错；
            // 历史附件缺失只降级为提示，不能阻断用户继续提问。
            if (i === latest) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`历史附件 ${a.id} 读取失败，本次运行仅保留元数据: ${msg}`);
          }
        }
        target.push({
          kind: a.kind,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
          ...(data ? { data } : {}),
        });
      }
    }
    return out;
  }
}

function toPrepared(row: {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  storageKey: string;
}): PreparedAttachment {
  return {
    id: row.id,
    kind: attachmentKindFor(row.filename, row.mime) ?? 'text',
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    storageKey: row.storageKey,
  };
}

function toDto(row: AttachmentRow, kind: AttachmentKind): AttachmentDto {
  return {
    id: row.id,
    kind,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  };
}
