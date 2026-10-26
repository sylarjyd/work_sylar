import { Injectable, NotFoundException } from '@nestjs/common';
import {
  attachmentKindFor,
  isAssistantPermissionMode,
  isSessionMode,
  normalizeSkills,
  type AssistantPermissionMode,
  type AssistantSkillKey,
  type AttachmentRef,
  type CreateSessionRequest,
  type MessageDto,
  type SessionMode,
  type SessionSummary,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { ModelUnavailableError, NoModelsAvailableError } from '../models/model.errors';

/** 运行期需要的助手配置；会话只存 id，配置每次运行时读取最新值。 */
export interface SessionAssistantRef {
  id: string;
  name: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  skills: AssistantSkillKey[];
  kbIds: string[];
}

export interface SessionRef {
  id: string;
  model: string | null;
  assistantId: string | null;
  assistantName: string | null;
  /** 任务分类；存量会话缺省按对话处理。 */
  mode: SessionMode;
  assistant: SessionAssistantRef | null;
}

interface AssistantRow {
  id: string;
  name: string;
  systemPrompt: string;
  permissionMode: string;
  /** 仅建会话选模时读取；运行时配置不需要。 */
  model?: string | null;
  skills: string[];
  kbIds: string[];
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ModelCatalogService,
  ) {}

  async list(tenantId: string, userId: string): Promise<SessionSummary[]> {
    // 归档会话对普通用户不可见。
    const rows = await this.prisma.session.findMany({
      where: { tenantId, userId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
      include: { assistant: { select: { name: true } } },
    });
    return rows.map(toSummary);
  }

  async create(
    tenantId: string,
    userId: string,
    req: CreateSessionRequest,
  ): Promise<SessionSummary> {
    // 助手归属先校验：越权 id 与不存在一律 404，不泄露他人助手是否存在。
    const assistantId =
      typeof req.assistantId === 'string' && req.assistantId.trim() !== ''
        ? req.assistantId.trim()
        : null;
    let assistant: AssistantRow | null = null;
    if (assistantId) {
      assistant = await this.prisma.assistant.findFirst({
        where: { id: assistantId, tenantId, userId },
        select: {
          id: true,
          name: true,
          systemPrompt: true,
          permissionMode: true,
          model: true,
          skills: true,
          kbIds: true,
        },
      });
      if (!assistant) throw new NotFoundException('assistant_not_found');
    }

    const { models, defaultModel } = await this.catalog.available(tenantId);
    if (models.length === 0) throw new NoModelsAvailableError();
    const requested = typeof req.model === 'string' ? req.model.trim() : '';
    // 显式选模优先；其次助手默认模型；最后运营端默认模型。
    const assistantModel = typeof req.model === 'string' ? '' : assistant?.model ?? '';
    const preferred = requested || assistantModel || '';
    let model = defaultModel ?? models[0].model;
    if (preferred) {
      if (!models.some((m) => m.model === preferred)) throw new ModelUnavailableError();
      model = preferred;
    }
    // 非法分类按对话处理：分类只影响提示词取向，不值得让建会话失败。
    const mode: SessionMode = isSessionMode(req.mode) ? req.mode : 'chat';
    let s;
    try {
      s = await this.prisma.session.create({
        data: { tenantId, userId, title: req.title ?? '新会话', model, assistantId, mode },
        include: { assistant: { select: { name: true } } },
      });
    } catch (err) {
      // 助手在校验后、写入前被删除：外键失败按 404 处理，避免 500。
      if ((err as { code?: string }).code === 'P2003') {
        throw new NotFoundException('assistant_not_found');
      }
      throw err;
    }
    return toSummary(s);
  }

  /**
   * 校验会话归属（tenant 强制行级隔离）：非本租户/用户或已归档一律 404，不泄露存在性。
   * 返回创建时选定的模型与助手配置，供任务控制器解析运行路由与运行参数。
   */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<SessionRef> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: { not: 'archived' } },
      include: {
        assistant: {
          select: {
            id: true,
            name: true,
            systemPrompt: true,
            permissionMode: true,
            skills: true,
            kbIds: true,
          },
        },
      },
    });
    if (!s) throw new NotFoundException('session_not_found');
    return {
      id: s.id,
      model: s.model ?? null,
      assistantId: s.assistantId ?? null,
      assistantName: s.assistant?.name ?? null,
      mode: isSessionMode(s.mode) ? s.mode : 'chat',
      assistant: s.assistant ? toAssistantRef(s.assistant) : null,
    };
  }

  async messages(sessionId: string, tenantId: string, userId: string): Promise<MessageDto[]> {
    await this.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
      include: {
        attachments: {
          select: { id: true, kind: true, filename: true, mime: true, size: true },
        },
      },
    });
    return rows.map((m) => ({
      id: m.id,
      role: m.role as MessageDto['role'],
      content: m.content,
      seq: m.seq,
      attachments: m.attachments.map(toAttachmentRef),
    }));
  }
}

function toAttachmentRef(row: {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
}): AttachmentRef {
  return {
    id: row.id,
    kind: attachmentKindFor(row.filename, row.mime) ?? 'text',
    filename: row.filename,
    mime: row.mime,
    size: row.size,
  };
}

function toAssistantRef(row: AssistantRow): SessionAssistantRef {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    permissionMode: isAssistantPermissionMode(row.permissionMode)
      ? row.permissionMode
      : 'standard',
    skills: normalizeSkills(row.skills),
    kbIds: row.kbIds ?? [],
  };
}

function toSummary(s: {
  id: string;
  title: string;
  createdAt: Date;
  model: string | null;
  mode: string;
  assistantId?: string | null;
  assistant?: { name: string } | null;
}): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt.toISOString(),
    model: s.model ?? null,
    assistantId: s.assistantId ?? null,
    assistantName: s.assistant?.name ?? null,
    mode: isSessionMode(s.mode) ? s.mode : 'chat',
  };
}
