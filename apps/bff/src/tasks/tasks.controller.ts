import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  HttpException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  toolsForSkills,
  type CreateTaskRequest,
} from '@ai-office/shared';
import { currentTrace } from '@ai-office/telemetry';
import { TasksService } from './tasks.service';
import {
  AttachmentsService,
  MAX_RUN_ATTACHMENT_BYTES,
  type PreparedAttachment,
} from '../attachments/attachments.service';
import { BillingService } from '../billing/billing.service';
import { SettingsService } from '../settings/settings.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { sealRoutes } from '../models/run-routes';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { QueueFullError, RunQueueService } from '../queue/run-queue.service';
import { RunRelayService } from '../queue/run-relay.service';
import type { RunSnapshot } from '../queue/run-job';
import { SessionTitleService } from '../sessions/session-title.service';
import { SkillsService } from '../skills/skills.service';

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly attachments: AttachmentsService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    private readonly catalog: ModelCatalogService,
    private readonly queue: RunQueueService,
    private readonly relay: RunRelayService,
    private readonly titles: SessionTitleService,
    private readonly skills: SkillsService,
  ) {}

  @Post(':id/tasks')
  async run(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: CreateTaskRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const goal = body?.goal;
    const rawIds = body?.attachmentIds;
    if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string' || !id))) {
      reply.status(400).send({ error: 'invalid_attachments' });
      return;
    }
    const attachmentIds = [...new Set((rawIds ?? []) as string[])];
    if (attachmentIds.length > ATTACHMENT_MAX_PER_MESSAGE) {
      reply.status(400).send({ error: 'too_many_attachments' });
      return;
    }

    // 边界校验：goal 必须是非空字符串；纯附件消息（只发文件不写文字）也允许。
    // 此时尚未建 task/run，也尚未 hijack，交给 Nest/Fastify 正常回 400 即可。
    if (typeof goal !== 'string' || (goal.length === 0 && attachmentIds.length === 0)) {
      reply.status(400).send({ error: 'invalid_goal' });
      return;
    }

    // 归属校验放在准入之前：404 不应留下副作用；返回值带出会话选定的模型与助手配置。
    // 与 prepare 内的归属校验重复一次查询，换取「404 早于准入」。
    const session = await this.tasks.assertOwned(sessionId, user.tenantId, user.sub);
    const assistant = session.assistant;
    // 技能正文在入队时固化：排队期间技能被改/下架不影响本次运行。
    const boundSkills = assistant
      ? await this.skills.resolveForRun(assistant.skillIds, user.tenantId, user.sub)
      : [];
    // 助手绑定时 skills 才生效：空数组表示禁用全部内置技能；未绑定助手时不限制工具。
    const runAssistant = assistant
      ? {
          systemPrompt: assistant.systemPrompt.trim() || undefined,
          enabledTools: toolsForSkills(assistant.skills),
          permissionMode: assistant.permissionMode,
          kbIds: assistant.kbIds.length > 0 ? assistant.kbIds : undefined,
          ...(boundSkills.length > 0 ? { skills: boundSkills } : {}),
        }
      : null;

    // 配置读取放在准入之前：读失败不应消耗准入额度。
    const config = await this.settings.getRunConfig();

    // 模型解析同样前置：套餐过期/模型停用/密钥不可用都不应消耗准入额度。
    let resolution: Awaited<ReturnType<ModelCatalogService['resolveForRun']>>;
    try {
      resolution = await this.catalog.resolveForRun(user.tenantId, session.model);
    } catch (err) {
      if (err instanceof HttpException) {
        reply.status(err.getStatus()).send({ error: err.message });
        return;
      }
      throw err;
    }

    // 附件预检放在准入之前：不存在、模态不支持或超出预算都不应消耗准入额度。
    // 这里只读元数据；真正的认领在 prepare 事务内完成，并发重复发送不会重复绑定。
    let pending: PreparedAttachment[] = [];
    if (attachmentIds.length > 0) {
      try {
        pending = await this.attachments.listOwnedUnclaimed(attachmentIds, user.tenantId, user.sub);
      } catch (err) {
        if (err instanceof HttpException) {
          reply.status(err.getStatus()).send({ error: err.message });
          return;
        }
        throw err;
      }
      const requiredKinds = [...new Set(pending.map((a) => a.kind))];
      const unsupported = requiredKinds.filter((kind) => !resolution.selectedModalities.includes(kind));
      if (unsupported.length > 0) {
        reply.status(400).send({
          error: 'model_modality_unsupported',
          model: resolution.selectedModel,
          modalities: unsupported,
        });
        return;
      }
      const totalBytes = pending.reduce((sum, a) => sum + a.size, 0);
      if (totalBytes > MAX_RUN_ATTACHMENT_BYTES) {
        reply.status(400).send({ error: 'attachments_too_large' });
        return;
      }
    }

    // 排队容量预检前置：队列已满时不能先落库用户消息/任务，也不应消耗 RPM 准入额度。
    // 并发提交仍可能越过上限，submit 时的校验保留为竞态兜底。
    try {
      await this.queue.assertCapacity(user.tenantId);
    } catch (err) {
      if (err instanceof QueueFullError) {
        reply.status(429).send({ error: 'queue_full' });
        return;
      }
      throw err;
    }

    // 快照固化入队时的模型、参数与助手配置，执行器不再读 settings/catalog；
    // messages 先留空，prepare 在事务内补入历史与本次用户消息后写回。
    const traceId = currentTrace()?.traceId ?? null;
    const snapshot: RunSnapshot = {
      goal,
      // 记录会话是否已有模型：null 时执行器在首次成功预占后回填。
      model: session.model,
      resolution: {
        selectedModel: resolution.selectedModel,
        // Task.input 会进备份与运维查询，厂商密钥必须加密后再落库。
        modelRoutes: sealRoutes(resolution.modelRoutes),
      },
      config,
      traceId,
      // 分类随每次运行固化：排队期间会话配置不再变化，但快照仍要自包含。
      mode: session.mode,
      assistant: runAssistant,
      messages: [],
    };
    const runId = randomUUID();

    // 准入在 hijack 之前返回；额度预占由执行器在真正开始执行时完成。
    try {
      await this.billing.admitRun(user.tenantId);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        reply
          .header('retry-after', String(err.retryAfter))
          .status(429)
          .send({ error: 'rate_limited', retryAfter: err.retryAfter });
        return;
      }
      if (err instanceof InsufficientCreditsError) {
        reply.status(402).send({ error: 'insufficient_credits' });
        return;
      }
      if (err instanceof PlanExpiredError) {
        reply.status(402).send({ error: 'plan_expired' });
        return;
      }
      throw err;
    }

    const { taskId, tenantId, userId, firstMessage } = await this.tasks.prepare(
      sessionId,
      user.tenantId,
      user.sub,
      goal,
      runId,
      traceId,
      attachmentIds,
      snapshot,
    );

    try {
      await this.queue.submit({ runId, taskId, sessionId, tenantId, userId });
    } catch (err) {
      // 作业没能提交：刚建的 task/run 不会有人执行，必须标记失败，避免前端一直排队。
      await this.markFailed(runId, taskId, sessionId);
      if (err instanceof QueueFullError) {
        reply.status(429).send({ error: 'queue_full' });
        return;
      }
      throw err;
    }

    // 首条消息才命名：后续轮次的主题可能偏离首条，改标题交给用户手动操作。
    // 放在入队成功之后：没提交的任务没必要花一次模型调用。
    if (firstMessage) {
      this.titles.schedule({
        sessionId,
        tenantId: user.tenantId,
        userId: user.sub,
        goal,
        attachmentName: pending[0]?.filename,
        // 此时 routes 仍是明文；快照里的版本已加密，不能拿来调用。
        routes: resolution.modelRoutes,
      });
    }

    try {
      await this.relay.attach(runId, reply);
    } catch (err) {
      // 转发器在 hijack 之前确认 run 存在；此时仍可由 Nest 正常写 404。
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'run_not_found' });
        return;
      }
      throw err;
    }
  }

  /** 入队失败后的收尾：落库失败只记日志，不能掩盖原始的入队异常。 */
  private async markFailed(runId: string, taskId: string, sessionId: string): Promise<void> {
    try {
      await this.tasks.finish(runId, taskId, 'failed', '', sessionId);
    } catch (err) {
      this.logger.error(`run ${runId} 入队失败后标记 failed 失败: ${(err as Error).message}`);
    }
  }
}
