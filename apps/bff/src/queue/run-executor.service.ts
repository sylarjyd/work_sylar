import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AgentEvent,
  ArtifactRef,
  ChatMessage,
  RunBilling,
  RunModelRoute,
  SseMessage,
  UsageEvent,
} from '@ai-office/shared';
import { createSseParser } from '@ai-office/shared';
import { endSpan, injectTraceparent, startSpan } from '@ai-office/telemetry';
import { parseSnapshot, type RunJob, type RunSnapshot } from './run-job';
import { RUN_CONTROL_BUS, RUN_EVENT_BUS } from './queue.tokens';
import type { RunEventBus } from './run-event-bus';
import type { RunControlBus } from './run-control-bus';
import { TasksService } from '../tasks/tasks.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { ArtifactService } from '../artifacts/artifacts.service';
import { BillingService } from '../billing/billing.service';
import { InsufficientCreditsError, PlanExpiredError } from '../billing/billing.errors';
import { parseUsageEvent } from '../billing/usage';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { RunTelemetry } from '../observability/run-telemetry';
import { unsealRoutes } from '../models/run-routes';
import { errorPayload, type RunErrorCode } from './run-errors';

/** 上游建连超时：只约束 fetch 拿到响应头，不中断已建立的长流。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
/** 上游流空闲超时：超过该时长未收到任何 chunk 视为 runtime 卡死。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// 项目未启用 DOM lib，`ReadableStreamReadResult` 不存在，从 reader.read 推导。
type StreamReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>;

/** 带空闲超时的读取：超时后 reject，避免上游卡死导致执行器与 hold 永久悬挂。 */
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

/**
 * 队列运行执行器：把原控制器 run() 的执行语义抽出来，供 worker 复用。
 * 与 HTTP 解耦——不写任何回复，事件一律经 RunEventBus 发布给 SSE 转发器；
 * 所有失败路径自行落库/释放预占，不向 worker 抛异常。
 */
@Injectable()
export class RunExecutor {
  private readonly logger = new Logger(RunExecutor.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly attachments: AttachmentsService,
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
    @Inject(RUN_EVENT_BUS) private readonly events: RunEventBus,
    @Inject(RUN_CONTROL_BUS) private readonly control: RunControlBus,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}

  async execute(job: RunJob): Promise<void> {
    const { runId } = job;
    // runtime 地址在订阅前固定：转发确认与发起运行必须指向同一实例。
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
    // 取消/确认意图可能在执行器接管后的任意阶段到达：先订阅再开跑，
    // 所有中止路径共用一个 AbortController；退订放在最外层 finally，任何退出都只执行一次。
    let canceled = false;
    const abort = new AbortController();
    let unsubscribe: (() => void) | undefined;
    try {
      try {
        unsubscribe = await this.control.subscribe(runId, (msg) => {
          if (msg.type === 'cancel') {
            canceled = true;
            abort.abort();
            return;
          }
          if (msg.type === 'confirm') {
            // 不 await：控制分发不应被 runtime 的确认往返阻塞；失败由 forwardConfirm 自行兜底。
            void this.forwardConfirm(runtimeUrl, runtimeToken, runId, msg.confirmId, msg.approved);
          }
        });
      } catch (err) {
        // 订阅失败不能阻断运行：执行前的 DB 兜底检查仍能发现取消请求。
        this.logger.warn(`run ${runId} 订阅控制消息失败，继续执行: ${(err as Error).message}`);
      }
      await this.executeRun(job, {
        runtimeUrl,
        runtimeToken,
        isCanceled: () => canceled,
        abort,
      });
    } finally {
      if (unsubscribe) {
        try {
          await unsubscribe();
        } catch (err) {
          this.logger.warn(`run ${runId} 退订控制消息失败: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * 把确认决策转发给持有待确认 promise 的 runtime。
   * 决策丢失只会退化为 runtime 自身的确认超时，因此这里绝不抛出：转发失败只记日志，
   * 不能因一次确认投递失败把正在执行的 run 拖垮。
   */
  private async forwardConfirm(
    baseUrl: string,
    token: string | undefined,
    runId: string,
    confirmId: string,
    approved: boolean,
  ): Promise<void> {
    try {
      const res = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 配了共享密钥才带；与发起运行时的鉴权头保持一致。
          ...(token ? { 'x-agent-runtime-token': token } : {}),
        },
        body: JSON.stringify({ confirmId, approved }),
      });
      if (!res.ok) {
        // 不关心错误体内容，但必须取消 body，避免连接/流资源残留。
        await res.body?.cancel().catch(() => undefined);
        this.logger.warn(`run ${runId} 转发确认决策失败（HTTP ${res.status}）`);
      }
    } catch (err) {
      this.logger.warn(`run ${runId} 转发确认决策失败: ${(err as Error).message}`);
    }
  }

  /** 执行主体；取消状态由 execute 注入，保证各退出点共享同一个信号与退订时机。 */
  private async executeRun(
    job: RunJob,
    opts: {
      runtimeUrl: string;
      runtimeToken: string | undefined;
      isCanceled: () => boolean;
      abort: AbortController;
    },
  ): Promise<void> {
    const { runId, taskId, sessionId, tenantId, userId } = job;
    const { runtimeUrl, runtimeToken, abort } = opts;

    // 出队执行前预占：入队时只做准入，额度在这里才真正锁定。
    let billing: RunBilling;
    try {
      billing = await this.billing.beginRun(runId, tenantId);
    } catch (err) {
      const error: RunErrorCode =
        err instanceof PlanExpiredError
          ? 'plan_expired'
          : err instanceof InsufficientCreditsError
            ? 'insufficient_credits'
            : 'run_failed';
      this.logger.error(`run ${runId} 预占失败（${error}）: ${(err as Error).message}`);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      await this.publish(runId, { event: 'error', data: errorPayload(error) });
      return;
    }

    // 执行细节全部来自入队快照，避免排队期间配置/模型漂移。
    // 读取、结构校验与取 selectedModel 必须在同一 try 内：残缺快照也要走归还预占的失败路径。
    let snapshot: RunSnapshot;
    try {
      snapshot = parseSnapshot(await this.tasks.loadSnapshot(taskId));
      billing = { ...billing, selectedModel: snapshot.resolution.selectedModel };
    } catch (err) {
      this.logger.error(`run ${runId} 读取运行快照失败: ${(err as Error).message}`);
      await this.releaseHold(runId);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      await this.publish(runId, { event: 'error', data: errorPayload('run_failed') });
      return;
    }

    // 快照中的路由密钥是密文，下发 runtime 前必须解密；解密失败按快照不可用收尾。
    let modelRoutes: RunModelRoute[];
    try {
      modelRoutes = unsealRoutes(snapshot.resolution.modelRoutes);
    } catch (err) {
      this.logger.error(`run ${runId} 解密模型路由失败: ${(err as Error).message}`);
      await this.releaseHold(runId);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      await this.publish(runId, { event: 'error', data: errorPayload('run_failed') });
      return;
    }

    // 排队期间提交的取消可能早于订阅建立；以 DB 里的取消请求兜底，避免白跑一次模型调用。
    if (opts.isCanceled() || (await this.isCancelRequested(runId))) {
      await this.releaseHold(runId);
      await this.safeFinish(runId, taskId, 'canceled', '', sessionId);
      await this.publishCanceled(runId);
      return;
    }

    // 历史会话在首次成功预占后固化模型；失败只记日志，不影响本次运行。
    if (snapshot.model == null) {
      try {
        await this.tasks.bindModel(sessionId, snapshot.resolution.selectedModel);
      } catch (err) {
        this.logger.warn(`run ${runId} 回填会话模型失败: ${(err as Error).message}`);
      }
    }

    // 附件字节在事务外读取；读取失败时 task/run 已存在，必须失败收尾并归还预占。
    let messages: ChatMessage[];
    try {
      messages = await this.attachments.hydrateForRun(snapshot.messages);
    } catch (err) {
      this.logger.error(`run ${runId} 读取附件失败: ${(err as Error).message}`);
      await this.releaseHold(runId);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      await this.publish(runId, { event: 'error', data: errorPayload('attachment_unavailable') });
      return;
    }

    const runTelemetry = new RunTelemetry(this.metrics);
    const runStarted = Date.now();
    let status: 'done' | 'failed' | 'canceled' = 'done';
    let latestUsage: UsageEvent | null = null;

    try {
      let upstream: Response;
      // 建连超时与用户取消复用同一信号：超时按失败收尾，取消则按 canceled 收尾。
      const connectTimer = setTimeout(() => abort.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
      // traceId 只作为关联属性，避免伪造父上下文；缺省时不下发该字段。
      const runtimeSpan = startSpan('runtime.run', {
        'run.id': runId,
        ...(snapshot.traceId ? { 'run.trace_id': snapshot.traceId } : {}),
      });
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
            goal: snapshot.goal,
            messages,
            billing,
            config: snapshot.config,
            ...(modelRoutes.length > 0 ? { modelRoutes } : {}),
            ...(snapshot.assistant
              ? {
                  ...(snapshot.assistant.systemPrompt
                    ? { systemPrompt: snapshot.assistant.systemPrompt }
                    : {}),
                  enabledTools: snapshot.assistant.enabledTools,
                  permissionMode: snapshot.assistant.permissionMode,
                  ...(snapshot.assistant.kbIds ? { kbIds: snapshot.assistant.kbIds } : {}),
                }
              : {}),
          }),
          signal: abort.signal,
        });
        endSpan(runtimeSpan, upstream.ok);
      } catch (err) {
        endSpan(runtimeSpan, false, err);
        // abort 同时来自建连超时与用户取消：必须先区分，否则取消会被误报成上游故障。
        if (opts.isCanceled() || (await this.isCancelRequested(runId))) {
          status = 'canceled';
          this.logger.log(`run ${runId} 已按取消请求中止（建连阶段）`);
          await this.releaseHold(runId);
          await this.safeFinish(runId, taskId, 'canceled', '', sessionId);
          await this.publishCanceled(runId);
          return;
        }
        // 传输层失败（含建连超时）：上游不可达，归还预占并失败收尾。
        runTelemetry.forceFail();
        this.logger.error(`run ${runId} 上游不可达: ${(err as Error).message}`);
        await this.releaseHold(runId);
        await this.safeFinish(runId, taskId, 'failed', '', sessionId);
        await this.publish(runId, { event: 'error', data: errorPayload('upstream_unreachable') });
        return;
      } finally {
        // 建连已有结果就撤销定时器：不能中断随后建立的长流。
        clearTimeout(connectTimer);
      }

      if (!upstream.ok) {
        runTelemetry.forceFail();
        // 不读取错误响应体，但必须取消 body，避免长连接/流资源残留。
        await upstream.body?.cancel().catch(() => undefined);
        this.logger.error(
          `run ${runId} 上游返回 ${upstream.status}（${upstream.headers.get('content-type') ?? 'unknown'}）`,
        );
        await this.releaseHold(runId);
        await this.safeFinish(runId, taskId, 'failed', '', sessionId);
        await this.publish(runId, { event: 'error', data: errorPayload('upstream_error') });
        return;
      }

      if (!upstream.body) {
        // 2xx 却没有 body 属于上游异常，不能当成空流成功收尾。
        runTelemetry.forceFail();
        this.logger.error(`run ${runId} 上游返回空响应体`);
        await this.releaseHold(runId);
        await this.safeFinish(runId, taskId, 'failed', '', sessionId);
        await this.publish(runId, { event: 'error', data: errorPayload('upstream_empty_body') });
        return;
      }

      const parse = createSseParser();
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();
      const thinkTexts: string[] = [];

      try {
        for (;;) {
          const { done, value } = await readWithIdleTimeout(reader, UPSTREAM_IDLE_TIMEOUT_MS);
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const m of parse(chunk)) {
            if (m.event === 'step') {
              const ev = m.data as AgentEvent;
              if (ev.type === 'think') thinkTexts.push(String(ev.payload.text ?? ''));
              await this.tasks.recordStep(runId, ev);
              if (ev.type === 'artifact') {
                await this.safeRecordArtifact(runId, sessionId, tenantId, ev.payload);
              }
              // 只有 step 需要实时转发；usage/checkpoint 由执行器内部消费。
              await this.publish(runId, { event: 'step', data: ev });
            } else if (m.event === 'usage') {
              const usage = parseUsageEvent(m.data);
              // runtime 每个 run 只发一次 usage（agent-loop 的 finally），覆盖保存最后一条即可。
              if (usage) {
                latestUsage = usage;
              } else {
                const raw = JSON.stringify(m.data) ?? String(m.data);
                this.logger.warn(`run ${runId} usage 事件非法，已忽略: ${raw.slice(0, 500)}`);
              }
            } else if (m.event === 'error') {
              status = 'failed';
            }
            // checkpoint 暂不消费；Task 13 接入续跑时再落库。
          }
        }
      } catch (err) {
        // 读取阶段的 abort 同样可能来自用户取消：取消不是故障，不发 error 帧。
        if (opts.isCanceled() || (await this.isCancelRequested(runId))) {
          status = 'canceled';
          this.logger.log(`run ${runId} 已按取消请求中止（流式阶段）`);
        } else {
          // 读上游 / 解析 / 落库任何一环抛错，都必须把这次 run 记为 failed。
          status = 'failed';
          this.logger.error(`run ${runId} 处理失败，标记为 failed: ${(err as Error).message}`);
        }
        // 超时/取消/出错时主动终止上游，避免连接继续悬挂、资源泄漏。
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
            await this.releaseHold(runId);
          }
          // 只有用量成功落库后才结算；settle 失败保留 pending 待补偿任务重试。
          if (usageRecorded) {
            try {
              await this.billing.settle(runId);
            } catch (err) {
              this.metrics.billingSettleFailures.inc();
              this.logger.error(`run ${runId} 计费结算失败（保留 pending 待补偿）: ${(err as Error).message}`);
            }
          }
        } else {
          await this.releaseHold(runId);
        }
        // 取消不保留半截回答：用户已明确放弃这次运行。
        await this.safeFinish(
          runId,
          taskId,
          status,
          status === 'canceled' ? '' : thinkTexts.join('\n'),
          sessionId,
        );
        // 终止事件在结算与 finish 之后发布，订阅方收到即可结束本轮流。
        // canceled 用状态帧而不是 error：取消是用户主动行为，不是故障。
        await this.publish(
          runId,
          status === 'done'
            ? { event: 'done', data: { runId } }
            : status === 'canceled'
              ? { event: 'status', data: { runId, status: 'canceled' } }
              : { event: 'error', data: errorPayload('run_failed') },
        );
      }
    } catch (err) {
      // 兜底：未预期异常也不能让 worker 中断，按失败收尾后正常返回。
      status = 'failed';
      this.logger.error(`run ${runId} 执行异常，按 failed 收尾: ${(err as Error).message}`);
      await this.releaseHold(runId);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      await this.publish(runId, { event: 'error', data: errorPayload('run_failed') });
    } finally {
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

  /**
   * 执行器可能错过取消控制消息（发布早于订阅建立）：以 DB 的 cancelRequestedAt 兜底。
   * 查询失败按未取消处理，避免一次读故障把正常运行掐断（后续仍受控制消息约束）。
   */
  private async isCancelRequested(runId: string): Promise<boolean> {
    try {
      const run = await this.tasks.findRun(runId);
      return run.cancelRequestedAt != null;
    } catch (err) {
      this.logger.warn(`run ${runId} 查询取消请求失败，继续执行: ${(err as Error).message}`);
      return false;
    }
  }

  /** 取消终态：与排队取消共用同一条 status 事件，客户端无需区分取消路径。 */
  private async publishCanceled(runId: string): Promise<void> {
    await this.publish(runId, { event: 'status', data: { runId, status: 'canceled' } });
  }

  /** 落库收尾；失败只记日志，绝不向 worker 抛出。 */
  private async safeFinish(
    runId: string,
    taskId: string,
    status: 'done' | 'failed' | 'canceled',
    assistantText: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.tasks.finish(runId, taskId, status, assistantText, sessionId);
    } catch (err) {
      this.logger.error(`run ${runId} finish 落库失败: ${(err as Error).message}`);
    }
  }

  /** 释放预占；失败只记日志，由补偿任务兜底。 */
  private async releaseHold(runId: string): Promise<void> {
    try {
      await this.billing.releaseHold(runId);
    } catch (err) {
      this.logger.error(`run ${runId} 释放预占失败: ${(err as Error).message}`);
    }
  }

  /** 事件发布失败不能影响结算与收尾：总线只是旁路。 */
  private async publish(runId: string, msg: SseMessage): Promise<void> {
    try {
      await this.events.publish(runId, msg);
    } catch (err) {
      this.logger.warn(`run ${runId} 发布 ${msg.event} 事件失败: ${(err as Error).message}`);
    }
  }
}
