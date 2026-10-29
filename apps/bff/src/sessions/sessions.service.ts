import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  attachmentKindFor,
  isAssistantPermissionMode,
  isSessionMode,
  normalizeSkills,
  normalizeChartSpec,
  SESSION_PAGE_SIZE,
  type ActiveRunSummary,
  type AssistantPermissionMode,
  type AssistantSkillKey,
  type AttachmentRef,
  type CreateSessionRequest,
  type MessageDto,
  type SessionChartDto,
  type SessionMode,
  type SessionPage,
  type SessionSummary,
  type UpdateSessionRequest,
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
  /** 绑定的技能市场技能 ID；运行前解析成正文并在入队时固化。 */
  skillIds: string[];
  /** 助手绑定的连接器；会话未单独选择时以此为准。 */
  connectorIds: string[];
  kbIds: string[];
}

export interface SessionRef {
  id: string;
  model: string | null;
  assistantId: string | null;
  assistantName: string | null;
  /** 任务分类；存量会话缺省按对话处理。 */
  mode: SessionMode;
  /** 会话级额外技能（与助手绑定技能合并）。 */
  skillIds: string[];
  /** 会话级连接器；空表示全部已启用连接器。 */
  connectorIds: string[];
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
  skillIds?: string[];
  connectorIds?: string[];
  kbIds: string[];
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ModelCatalogService,
  ) {}

  async list(
    tenantId: string,
    userId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<SessionPage> {
    const limit = clampLimit(opts.limit);
    const cursor = opts.cursor?.trim() || undefined;
    // 归档/删除的会话对普通用户不可见。多取一条用于判断是否还有下一页，省掉额外 count。
    // 置顶优先，其余按创建时间倒序；createdAt 可能重复，追加 id 兜底，游标翻页才不重不漏。
    const rows = await this.prisma.session.findMany({
      where: { tenantId, userId, status: 'active' },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { assistant: { select: { name: true } } },
    });
    const page = rows.slice(0, limit);
    const active = await this.activeRuns(page.map((s) => s.id));
    const items = page.map((s) => toSummary(s, active.get(s.id) ?? null));
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  /** 单个会话摘要：深链到首屏之外的旧会话时，前端用它补齐侧栏与选模信息。 */
  async detail(sessionId: string, tenantId: string, userId: string): Promise<SessionSummary> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: 'active' },
      include: { assistant: { select: { name: true } } },
    });
    if (!s) throw new NotFoundException('session_not_found');
    const active = await this.activeRuns([s.id]);
    return toSummary(s, active.get(s.id) ?? null);
  }

  /**
   * 改名或置顶：两者都是一次行级更新，合并在同一方法里避免控制器拼装两次写。
   * 改名同时把标题来源标为 manual，之后的首条消息自动命名不再覆盖用户的选择。
   */
  async update(
    sessionId: string,
    tenantId: string,
    userId: string,
    req: UpdateSessionRequest,
  ): Promise<SessionSummary> {
    const data: { title?: string; titleSource?: string; pinned?: boolean } = {};
    if (req.title !== undefined) {
      const title = typeof req.title === 'string' ? req.title.trim() : '';
      // 标题会直接进侧栏与顶栏，限制长度避免布局被超长输入撑坏。
      if ([...title].length < 1 || [...title].length > MAX_TITLE_LENGTH) {
        throw new BadRequestException('invalid_title');
      }
      data.title = title;
      data.titleSource = 'manual';
    }
    if (req.pinned !== undefined) {
      if (typeof req.pinned !== 'boolean') throw new BadRequestException('invalid_pinned');
      data.pinned = req.pinned;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('empty_update');

    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, tenantId, userId, status: 'active' },
      data,
    });
    if (count === 0) throw new NotFoundException('session_not_found');
    return this.detail(sessionId, tenantId, userId);
  }

  /**
   * 软删除：只把状态推进到 deleted，消息/任务/产物保留，运营端仍可审计追溯。
   * 运行中的会话先拒绝删除，避免任务继续消耗额度却从界面上消失。
   */
  async remove(sessionId: string, tenantId: string, userId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: 'active' },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session_not_found');

    const busy = await this.prisma.task.findFirst({
      where: { sessionId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (busy) throw new ConflictException('session_busy');

    // 条件更新兜住并发删除：先查到、再删之间会话可能已不存在或被删除。
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, tenantId, userId, status: 'active' },
      data: { status: 'deleted' },
    });
    if (count === 0) throw new NotFoundException('session_not_found');
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
      // 公共内置助手所有租户可用；个人助手只能绑定自己的。
      assistant = await this.prisma.assistant.findFirst({
        where: {
          id: assistantId,
          OR: [{ scope: 'public' }, { tenantId, userId }],
        },
        select: {
          id: true,
          name: true,
          systemPrompt: true,
          permissionMode: true,
          model: true,
          skills: true,
          skillIds: true,
          connectorIds: true,
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

    // 会话级技能/连接器：只存校验通过的 id，越权或不存在的整单拒绝。
    const skillIds = [...new Set(Array.isArray(req.skillIds) ? req.skillIds : [])]
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (skillIds.length > 0) {
      const rows = await this.prisma.skill.findMany({
        where: { id: { in: skillIds } },
        select: { id: true, scope: true, enabled: true, tenantId: true, ownerUserId: true },
      });
      const visible = rows.filter(
        (row) =>
          (row.scope === 'public' && row.enabled) ||
          (row.scope === 'personal' && row.tenantId === tenantId && row.ownerUserId === userId),
      );
      if (visible.length !== skillIds.length) throw new BadRequestException('invalid_skill_ids');
    }
    const connectorIds = [...new Set(Array.isArray(req.connectorIds) ? req.connectorIds : [])]
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (connectorIds.length > 0) {
      const rows = await this.prisma.connector.findMany({
        where: { id: { in: connectorIds }, tenantId },
        select: { id: true },
      });
      if (rows.length !== connectorIds.length) {
        throw new BadRequestException('invalid_connector_ids');
      }
    }

    let s;
    try {
      s = await this.prisma.session.create({
        data: {
          tenantId,
          userId,
          title: req.title ?? '新会话',
          model,
          assistantId,
          mode,
          skillIds,
          connectorIds,
        },
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
   * 校验会话归属（tenant 强制行级隔离）：非本租户/用户、已归档或已删除一律 404，不泄露存在性。
   * 返回创建时选定的模型与助手配置，供任务控制器解析运行路由与运行参数。
   */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<SessionRef> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: 'active' },
      include: {
        assistant: {
          select: {
            id: true,
            name: true,
            systemPrompt: true,
            permissionMode: true,
            skills: true,
            skillIds: true,
            connectorIds: true,
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
      skillIds: s.skillIds ?? [],
      connectorIds: s.connectorIds ?? [],
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

  /**
   * 会话内的图表：图表只是 step 的一种，运行结束后 tracker 会清空，
   * 历史视图要靠这里把 chart step 重新读出来（按时间倒序取最近 50 张）。
   * payload 仍做一次校验，历史数据里的脏结构直接跳过而不是让接口 500。
   */
  async charts(sessionId: string, tenantId: string, userId: string): Promise<SessionChartDto[]> {
    await this.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.step.findMany({
      where: { type: 'chart', run: { task: { sessionId } } },
      orderBy: { ts: 'desc' },
      take: 50,
      select: { id: true, runId: true, seq: true, payload: true, ts: true },
    });
    const charts: SessionChartDto[] = [];
    for (const row of rows) {
      const spec = normalizeChartSpec(row.payload);
      if (!spec) continue;
      charts.push({
        id: row.id,
        runId: row.runId,
        seq: row.seq,
        title: spec.title ?? '数据图表',
        spec,
        createdAt: row.ts.toISOString(),
      });
    }
    return charts;
  }

  /**
   * 批量查询会话当前活跃运行。失败降级为无标记：侧栏提示缺失不应让列表整体失败。
   * 同一会话理论上只会有一条（前端串行发送）；异常多条时运行中优先，其次排队中。
   */
  private async activeRuns(sessionIds: string[]): Promise<Map<string, ActiveRunSummary>> {
    const out = new Map<string, ActiveRunSummary>();
    if (sessionIds.length === 0) return out;
    try {
      const rows = await this.prisma.run.findMany({
        where: {
          task: { sessionId: { in: sessionIds } },
          status: { in: ['queued', 'running'] },
        },
        select: { id: true, status: true, task: { select: { sessionId: true } } },
      });
      for (const r of rows) {
        if (r.status !== 'queued' && r.status !== 'running') continue;
        const sid = r.task.sessionId;
        const seen = out.get(sid);
        if (seen && (seen.status === 'running' || r.status === 'queued')) continue;
        out.set(sid, { id: r.id, status: r.status });
      }
    } catch (err) {
      this.logger.warn(
        `activeRun query failed (sessions=${sessionIds.length}): ${(err as Error).message}`,
      );
    }
    return out;
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
    skillIds: row.skillIds ?? [],
    connectorIds: row.connectorIds ?? [],
    kbIds: row.kbIds ?? [],
  };
}

function toSummary(
  s: {
    id: string;
    title: string;
    createdAt: Date;
    model: string | null;
    mode: string;
    assistantId?: string | null;
    assistant?: { name: string } | null;
    pinned?: boolean;
  },
  activeRun: ActiveRunSummary | null = null,
): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt.toISOString(),
    model: s.model ?? null,
    assistantId: s.assistantId ?? null,
    assistantName: s.assistant?.name ?? null,
    mode: isSessionMode(s.mode) ? s.mode : 'chat',
    pinned: s.pinned === true,
    activeRun,
  };
}

/** 每页上限：前端只需要首屏 20 条，放大上限仅用于运维手工排查。 */
const MAX_PAGE_SIZE = 100;

/** 会话标题上限：侧栏会截断展示，过长标题只会在编辑框里妨碍输入。 */
const MAX_TITLE_LENGTH = 40;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return SESSION_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}
