import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpException, Inject, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AgentEvent, ArtifactRef, RunBilling, UsageEvent } from '@ai-office/shared';
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  createSseParser,
  toolsForSkills,
  type CreateTaskRequest,
} from '@ai-office/shared';
import { currentTrace, endSpan, injectTraceparent, startSpan } from '@ai-office/telemetry';
import { TasksService } from './tasks.service';
import {
  AttachmentsService,
  MAX_RUN_ATTACHMENT_BYTES,
  type PreparedAttachment,
} from '../attachments/attachments.service';
import { ArtifactService } from '../artifacts/artifacts.service';
import { BillingService } from '../billing/billing.service';
import { SettingsService } from '../settings/settings.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';
import { parseUsageEvent } from '../billing/usage';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { writeHead } from '../stream/sse-proxy';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { RunTelemetry } from '../observability/run-telemetry';

/** 上游建连超时：只约束 fetch 拿到响应头，不中断已建立的长流。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
/** 上游流空闲超时：超过该时长未收到任何 chunk 视为 runtime 卡死。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** 非 2xx 错误体读取超时：避免上游发完响应头后 body 停滞导致已 hijack 的响应永久挂起。 */
const UPSTREAM_ERROR_BODY_TIMEOUT_MS = 10_000;

// 项目未启用 DOM lib，`ReadableStreamReadResult` 不存在，从 reader.read 推导。
type StreamReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>;

/** 带空闲超时的读取：超时后 reject，避免上游卡死导致请求与 hold 永久悬挂。 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<StreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('upstream_idle_timeout')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([reader.read(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<StreamReadResult<Uint8Array>>;
}

/** 有界读取上游响应体：非 2xx 时只用于回显，避免恶意/异常上游撑爆内存或长期停滞。 */
async function readBodyLimited(
  res: Response,
  limit = 8192,
  timeoutMs = UPSTREAM_ERROR_BODY_TIMEOUT_MS,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < limit) {
      const { done, value } = await readWithIdleTimeout(reader, timeoutMs);
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.slice(0, limit);
}

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly attachments: AttachmentsService,
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    private readonly catalog: ModelCatalogService,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}

  @Post(':id/tasks')
  async run(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: CreateTaskRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
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

    // 归属校验放在预占之前：404 不应留下 hold；返回值带出会话选定的模型与助手配置。
    // 与 prepare 内的归属校验重复一次查询，换取「404 早于预占」。
    const session = await this.tasks.assertOwned(sessionId, user.tenantId, user.sub);
    const assistant = session.assistant;
    // 助手绑定时 skills 才生效：空数组表示禁用全部内置技能；未绑定助手时不限制工具。
    const runAssistant = assistant
      ? {
          systemPrompt: assistant.systemPrompt.trim() || undefined,
          enabledTools: toolsForSkills(assistant.skills),
          permissionMode: assistant.permissionMode,
          kbDocIds: assistant.kbDocIds.length > 0 ? assistant.kbDocIds : undefined,
        }
      : null;

    // 配置读取放在预占之前：读失败不应留下 hold。
    const config = await this.settings.getRunConfig();

    // 模型解析同样前置：套餐过期/模型停用/密钥不可用都不应留下 hold。
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

    // 附件预检放在预占之前：不存在、模态不支持或超出预算都不应留下 hold。
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

    // 预占额度并做限流；失败在 hijack 之前返回，Nest 可正常写响应。
    const runId = randomUUID();
    let billing: RunBilling;
    try {
      billing = await this.billing.beginRun(runId, user.tenantId);
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

    // 历史会话在首次成功预占后固化模型；失败只记日志，不影响本次运行。
    if (!session.model) {
      try {
        await this.tasks.bindModel(sessionId, resolution.selectedModel);
      } catch (err) {
        this.logger.warn(`run ${runId} 回填会话模型失败: ${(err as Error).message}`);
      }
    }
    billing = { ...billing, selectedModel: resolution.selectedModel };

    let prepared: Awaited<ReturnType<TasksService['prepare']>>;
    try {
      prepared = await this.tasks.prepare(
        sessionId,
        user.tenantId,
        user.sub,
        goal,
        runId,
        // onRequest 已建立请求 span；这里把同一条 trace 固化到 run，便于事后按 trace 反查。
        currentTrace()?.traceId ?? null,
        attachmentIds,
      );
    } catch (err) {
      // 建 task/run 失败：归还预占（best-effort），再交给 Nest 处理原异常。
      await this.billing.releaseHold(runId).catch(() => undefined);
      throw err;
    }
    const { taskId, tenantId, userId } = prepared;

    // 附件字节在事务外读取：避免把对象存储的慢请求拖进数据库事务。
    // 读取失败时 task/run 已落库，必须标记失败并归还预占，不能留下永远 running 的孤儿。
    let messages;
    try {
      messages = await this.attachments.hydrateForRun(prepared.messages);
    } catch (err) {
      await this.billing.releaseHold(runId).catch(() => undefined);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      if (err instanceof HttpException) {
        reply.status(err.getStatus()).send({ error: err.message });
        return;
      }
      this.logger.error(`run ${runId} 读取附件失败: ${(err as Error).message}`);
      reply.status(502).send({ error: 'attachment_unavailable' });
      return;
    }

    // 运行指标从建好 task/run 之后开始统计；结算失败计数也走同一 BFF 指标注册表。
    const runTelemetry = new RunTelemetry(this.metrics);
    const runStarted = Date.now();
    let status: 'done' | 'failed' = 'done';
    let latestUsage: UsageEvent | null = null;

    // 接管回复：本方法直接写 reply.raw，必须 hijack，否则 Nest/Fastify 会再自动发一次响应。
    reply.hijack();

    try {
      // 客户端断开后停止写回复，但**继续排空上游**：否则 usage 与产物会漏落库。
      // socket error 无监听会崩进程，所以 error 也挂同一个处理器。
      let clientGone = false;
      const onClientGone = (): void => {
        clientGone = true;
      };
      reply.raw.on('error', onClientGone);
      reply.raw.on('close', onClientGone);

      let upstream: Response;
      const connectController = new AbortController();
      const connectTimer = setTimeout(() => connectController.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
      // 上游调用单独成 span，并把它的 traceparent 注入请求头，runtime 侧会作为子 span 续接。
      const runtimeSpan = startSpan('runtime.run', { 'run.id': runId });
      const upstreamHeaders: Record<string, string> = {
        'content-type': 'application/json',
        // 配了共享密钥才带；不配时与未开启鉴权的 runtime 保持兼容。
        ...(runtimeToken ? { 'x-agent-runtime-token': runtimeToken } : {}),
      };
      injectTraceparent(upstreamHeaders, runtimeSpan);
      try {
        upstream = await fetch(`${runtimeUrl}/runs`, {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify({
            runId,
            sessionId,
            tenantId,
            userId,
            goal,
            messages,
            billing,
            config,
            ...(resolution.modelRoutes.length > 0
              ? { modelRoutes: resolution.modelRoutes }
              : {}),
            ...(runAssistant
              ? {
                  ...(runAssistant.systemPrompt
                    ? { systemPrompt: runAssistant.systemPrompt }
                    : {}),
                  enabledTools: runAssistant.enabledTools,
                  permissionMode: runAssistant.permissionMode,
                  ...(runAssistant.kbDocIds ? { kbDocIds: runAssistant.kbDocIds } : {}),
                }
              : {}),
          }),
          signal: connectController.signal,
        });
        endSpan(runtimeSpan, upstream.ok);
      } catch (err) {
        endSpan(runtimeSpan, false, err);
        // 传输层失败（含建连超时）：上游不可达，归还预占并回 502 而不是未捕获的 500。
        runTelemetry.forceFail();
        await this.billing.releaseHold(runId).catch(() => undefined);
        await this.safeFinish(runId, taskId, 'failed', '', sessionId);
        writeHead(reply, 502, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
        return;
      } finally {
        // 建连已有结果就撤销定时器：不能中断随后建立的长流。
        clearTimeout(connectTimer);
      }

      if (!upstream.ok) {
        // 上游非 2xx：归还预占，原样转发真实状态码与响应体，不伪装成 200 text/event-stream。
        runTelemetry.forceFail();
        await this.billing.releaseHold(runId).catch(() => undefined);
        await this.safeFinish(runId, taskId, 'failed', '', sessionId);
        const contentType = upstream.headers.get('content-type') ?? 'application/json';
        let body: string;
        try {
          body = await readBodyLimited(upstream);
        } catch {
          body = JSON.stringify({ error: 'upstream_error' });
        }
        if (!body) body = JSON.stringify({ error: 'upstream_error' });
        try {
          writeHead(reply, upstream.status, { 'content-type': contentType });
          reply.raw.end(body);
        } catch (err) {
          // 写响应失败也必须终止响应，否则已 hijack 的请求会一直挂起。
          this.logger.error(`run ${runId} 转发上游错误响应失败: ${(err as Error).message}`);
          try {
            reply.raw.end();
          } catch {
            // 客户端已断开时 end() 可能抛错，忽略。
          }
        }
        return;
      }

      if (!upstream.body) {
        // 2xx 却没有 body：属于上游异常。不能回 200 + upstream_error，否则客户端会
        // 误以为成功；明确回 502，并同样保证 end 容错。
        runTelemetry.forceFail();
        await this.billing.releaseHold(runId).catch(() => undefined);
        await this.safeFinish(runId, taskId, 'failed', '', sessionId);
        try {
          writeHead(reply, 502, { 'content-type': 'application/json' });
          reply.raw.end(JSON.stringify({ error: 'upstream_empty_body' }));
        } catch (err) {
          this.logger.error(`run ${runId} 转发上游空响应体失败: ${(err as Error).message}`);
          try {
            reply.raw.end();
          } catch {
            // 客户端已断开时 end() 可能抛错，忽略。
          }
        }
        return;
      }

    writeHead(reply, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const parse = createSseParser();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const thinkTexts: string[] = [];

    try {
      for (;;) {
        const { done, value } = await readWithIdleTimeout(reader, UPSTREAM_IDLE_TIMEOUT_MS);
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!clientGone) reply.raw.write(chunk);
        for (const m of parse(chunk)) {
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            if (ev.type === 'think') thinkTexts.push(String(ev.payload.text ?? ''));
            await this.tasks.recordStep(runId, ev);
            if (ev.type === 'artifact') {
              await this.safeRecordArtifact(runId, sessionId, tenantId, ev.payload);
            }
          } else if (m.event === 'usage') {
            const usage = parseUsageEvent(m.data);
            // runtime 每个 run 只发一次 usage（agent-loop 的 finally），故覆盖保存最后一条即可。
            if (usage) {
              latestUsage = usage;
            } else {
              const raw = JSON.stringify(m.data) ?? String(m.data);
              this.logger.warn(`run ${runId} usage 事件非法，已忽略: ${raw.slice(0, 500)}`);
            }
          } else if (m.event === 'error') {
            status = 'failed';
          }
        }
      }
    } catch (err) {
      // 读上游 / 解析 / 落库任何一环抛错，都必须把这次 run 记为 failed，
      // 否则会带着默认的 'done' 落库，把失败的运行伪装成成功。
      status = 'failed';
      this.logger.error(`run ${runId} 处理失败，标记为 failed: ${(err as Error).message}`);
      // 超时/出错时主动终止上游，避免连接继续悬挂、资源泄漏。
      await reader.cancel().catch(() => undefined);
    } finally {
      // 结算优先于 finish：即使 finish 失败，用量也已落账。
      // 结算抛错时保留 hold 与 pending，由补偿任务重试。
      if (latestUsage) {
        let usageRecorded = false;
        try {
          await this.recordUsageWithRetry(runId, { tenantId, userId, sessionId }, latestUsage);
          usageRecorded = true;
        } catch (err) {
          // 重试全部失败：释放预占，避免 hold 滞留到 24h TTL。
          this.logger.error(
            `run ${runId} 用量记录失败，已尽力重试，将释放预占；用量=${JSON.stringify(latestUsage)}: ${(err as Error).message}`,
          );
          await this.billing.releaseHold(runId).catch((e) => {
            this.logger.error(`run ${runId} 释放预占失败: ${(e as Error).message}`);
          });
        }
        // 只有用量成功落库后才结算；settle 失败保留 pending 待补偿任务重试。
        if (usageRecorded) {
          try {
            await this.billing.settle(runId);
          } catch (err) {
            // settle 失败时 hold 与 pending 都还在，由补偿任务重试。
            this.metrics.billingSettleFailures.inc();
            this.logger.error(`run ${runId} 计费结算失败（保留 pending 待补偿）: ${(err as Error).message}`);
          }
        }
      } else {
        try {
          await this.billing.releaseHold(runId);
        } catch (err) {
          this.logger.error(`run ${runId} 释放预占失败: ${(err as Error).message}`);
        }
      }
      await this.safeFinish(runId, taskId, status, thinkTexts.join('\n'), sessionId);
      try {
        reply.raw.end();
      } catch {
        // 客户端已断开时 end() 可能抛错，忽略。
      }
    }
    } finally {
      // 所有返回路径（含 502、非 2xx、空 body）都经这里收尾；finish 自身幂等。
      runTelemetry.finish(status, latestUsage, billing, (Date.now() - runStarted) / 1000);
    }
  }

  /** 产物落库失败只记日志，绝不中断 SSE 流（与 safeFinish 同样的容错姿态）。 */
  private async safeRecordArtifact(
    runId: string,
    sessionId: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.artifacts.record(runId, sessionId, tenantId, payload as unknown as ArtifactRef);
    } catch (err) {
      this.logger.error(`run ${runId} artifact 落库失败: ${(err as Error).message}`);
    }
  }

  /** 记录用量：瞬时故障最多重试 3 次（100ms/200ms 退避），全部失败才抛出最后一次错误。 */
  private async recordUsageWithRetry(
    runId: string,
    meta: { tenantId: string; userId: string; sessionId: string },
    usage: UsageEvent,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.billing.recordUsage(runId, meta, usage);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 200));
        }
      }
    }
    throw lastErr;
  }

  /** 落库收尾；失败只记日志，绝不向调用方抛出——否则会阻断后续的响应终止。 */
  private async safeFinish(
    runId: string,
    taskId: string,
    status: 'done' | 'failed',
    assistantText: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.tasks.finish(runId, taskId, status, assistantText, sessionId);
    } catch (err) {
      this.logger.error(`run ${runId} finish 落库失败: ${(err as Error).message}`);
    }
  }
}
