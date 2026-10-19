import { randomUUID } from 'node:crypto';
import { Body, Controller, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AgentEvent, ArtifactRef, RunBilling, UsageEvent } from '@ai-office/shared';
import { createSseParser, type CreateTaskRequest } from '@ai-office/shared';
import { TasksService } from './tasks.service';
import { ArtifactService } from '../artifacts/artifacts.service';
import { BillingService } from '../billing/billing.service';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';
import { parseUsageEvent } from '../billing/usage';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { writeHead } from '../stream/sse-proxy';

/** 上游建连超时：只约束 fetch 拿到响应头，不中断已建立的长流。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
/** 上游流空闲超时：超过该时长未收到任何 chunk 视为 runtime 卡死。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

/** 有界读取上游响应体：非 2xx 时只用于回显，避免恶意/异常上游撑爆内存。 */
async function readBodyLimited(res: Response, limit = 8192): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
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
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
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

    // 边界校验：goal 必须是非空字符串。此时尚未建 task/run，也尚未 hijack，
    // 交给 Nest/Fastify 正常回 400 即可。
    if (typeof goal !== 'string' || goal.length === 0) {
      reply.status(400).send({ error: 'invalid_goal' });
      return;
    }

    // 归属校验放在预占之前：404 不应留下 hold。
    // 与 prepare 内的归属校验重复一次查询，换取「404 早于预占」。
    await this.tasks.assertOwned(sessionId, user.tenantId, user.sub);

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

    let prepared: Awaited<ReturnType<TasksService['prepare']>>;
    try {
      prepared = await this.tasks.prepare(sessionId, user.tenantId, user.sub, goal, runId);
    } catch (err) {
      // 建 task/run 失败：归还预占（best-effort），再交给 Nest 处理原异常。
      await this.billing.releaseHold(runId).catch(() => undefined);
      throw err;
    }
    const { taskId, tenantId, userId, messages } = prepared;

    // 接管回复：本方法直接写 reply.raw，必须 hijack，否则 Nest/Fastify 会再自动发一次响应。
    reply.hijack();

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
    try {
      upstream = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 配了共享密钥才带；不配时与未开启鉴权的 runtime 保持兼容。
          ...(runtimeToken ? { 'x-agent-runtime-token': runtimeToken } : {}),
        },
        body: JSON.stringify({ runId, sessionId, tenantId, userId, goal, messages, billing }),
        signal: connectController.signal,
      });
    } catch {
      // 传输层失败（含建连超时）：上游不可达，归还预占并回 502 而不是未捕获的 500。
      await this.billing.releaseHold(runId).catch(() => undefined);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      writeHead(reply, 502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
      return;
    } finally {
      // 建连已有结果就撤销定时器：不能中断随后建立的长流。
      clearTimeout(connectTimer);
    }

    if (!upstream.ok || !upstream.body) {
      // 上游非 2xx：归还预占，原样转发真实状态码与响应体，不伪装成 200 text/event-stream。
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

    writeHead(reply, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const parse = createSseParser();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const thinkTexts: string[] = [];
    let status: 'done' | 'failed' = 'done';
    let latestUsage: UsageEvent | null = null;

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
        try {
          await this.recordUsageWithRetry(runId, { tenantId, userId, sessionId }, latestUsage);
        } catch (err) {
          this.logger.error(
            `run ${runId} 用量记录失败，已尽力重试，用量=${JSON.stringify(latestUsage)}: ${(err as Error).message}`,
          );
        }
        try {
          await this.billing.settle(runId);
        } catch (err) {
          // settle 失败时 hold 与 pending 都还在，由补偿任务重试。
          this.logger.error(`run ${runId} 计费结算失败（保留 pending 待补偿）: ${(err as Error).message}`);
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
