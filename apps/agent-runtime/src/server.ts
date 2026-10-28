import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { context, SpanKind, trace } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { encodeSse } from '@ai-office/shared';
import type { AgentEvent, RunRequest, RunResume } from '@ai-office/shared';
import {
  createLogger,
  endSpan,
  extractTraceContext,
  initTelemetry,
  runWithContext,
  shutdownTelemetry,
  startSpan,
} from '@ai-office/telemetry';
import { runAgent, type ToolObservation } from './agent-loop';
import { createRuntimeMetrics, type RuntimeMetrics } from './observability/metrics';
import type { ModelObserver } from './model/observed-gateway';
import { resolveRunConfig } from './run-config';
import { createGateway, createGatewayFromRoutes } from './model/create-gateway';
import type { ModelGateway } from './model/types';
import { createTools } from './tools/registry';
import { createSkillReadTool } from './tools/skill-read';
import { emit } from './tools/doc';
import type { Tool } from './tools/types';
import { ConfirmBroker } from './confirm/broker';
import { loadRootEnv } from './load-env';
import { createStorage, type Storage } from './storage/s3';
import { createEmbeddingGateway } from './embedding/create-embedding-gateway';
import type { EmbeddingGateway } from './embedding/types';
import { ingest } from './kb/ingest';
import { validateConnector as defaultValidateConnector } from './mcp/validate';
import type { McpToolInfo } from '@ai-office/shared';
import { McpHost } from './mcp/host';
import { fetchConnectors } from './mcp/bff-connector-client';
import { buildMcpTools } from './mcp/discovery';

/**
 * /runs 请求体上限：BFF 的附件预算是 32MiB 原始字节，base64 后约 42.7MiB，
 * 再留出 JSON 与历史消息余量。超过即拒绝，避免无界拼接字符串耗尽内存。
 */
const MAX_RUN_BODY_BYTES = 48 * 1024 * 1024;

/** /embed 请求体上限：64 条 × 4000 字符（UTF-8 最多 4 字节）再留 JSON 余量。 */
const MAX_EMBED_BODY_BYTES = 1024 * 1024;
const EMBED_MAX_TEXTS = 64;
const EMBED_MAX_TEXT_CHARS = 4000;
const EMBED_MAX_TOTAL_CHARS = 32_000;

export interface RuntimeDeps {
  gateway?: ModelGateway;
  tools?: Tool[];
  storage?: Storage;
  embedding?: EmbeddingGateway;
  /** 校验连接器的实现；测试可注入桩。 */
  validateConnector?: typeof defaultValidateConnector;
  /** 每次 run 追加的工具（按 tenantId）；测试可注入。默认从 BFF 拉连接器构建 MCP 工具。 */
  extraTools?: (tenantId: string) => Promise<Tool[]>;
  /** 测试注入指标；默认新建独立 Registry。 */
  metrics?: RuntimeMetrics;
  /** 测试注入日志；默认 pino。 */
  logger?: Logger;
}

export function createRuntimeServer(deps: RuntimeDeps = {}): Server {
  const metrics = deps.metrics ?? createRuntimeMetrics();
  const logger = deps.logger ?? createLogger('agent-runtime');
  const observer: ModelObserver = {
    onAttempt: (model, ok, durationMs) =>
      metrics.recordModelAttempt(model, ok ? 'ok' : 'error', durationMs),
    onFallback: (from, to) => metrics.recordModelFallback(from, to),
  };
  const gateway = deps.gateway ?? createGateway(process.env, observer);
  const storage = deps.storage ?? createStorage();
  const baseTools = deps.tools ?? createTools(process.env, storage);

  // 仅生产路径（既未注入 tools 也未注入 extraTools）才起常驻 MCP 池；
  // 测试注入任一，即不 spawn 真实子进程。注入的 extraTools 与注入的 tools 可并存。
  const mcpHost =
    deps.tools || deps.extraTools
      ? null
      : new McpHost({
          heartbeatMs: Number(process.env.MCP_HEARTBEAT_MS ?? 30000),
          backoffBaseMs: Number(process.env.MCP_BACKOFF_BASE_MS ?? 1000),
          backoffMaxMs: Number(process.env.MCP_BACKOFF_MAX_MS ?? 30000),
          initTimeoutMs: Number(process.env.MCP_INIT_TIMEOUT_MS ?? 10000),
          callTimeoutMs: Number(process.env.MCP_CALL_TIMEOUT_MS ?? 30000),
          onRestart: (server) => metrics.recordMcpRestart(server),
        });

  const extraTools = deps.extraTools ?? (mcpHost ? defaultExtraTools(mcpHost) : undefined);

  const embedding = deps.embedding ?? createEmbeddingGateway();
  const validateConn = deps.validateConnector ?? defaultValidateConnector;
  // runtime 单实例持有一份确认闸门；连接 close 时按 runId 取消挂起。
  const confirm = new ConfirmBroker();
  // 在途运行的中止控制器：客户端断开时置位，runAgent 在下个轮次/工具前停止。
  const controllers = new Map<string, AbortController>();

  // BFF→runtime 共享密钥：设置 AGENT_RUNTIME_TOKEN 后强制校验；
  // 未设置时失败关闭，仅放行回环来源——即使误绑 0.0.0.0，远程也无法触发
  // 模型调用或 spawn 子进程（连接器校验）。
  const authorized = (req: IncomingMessage): boolean => {
    const token = process.env.AGENT_RUNTIME_TOKEN;
    if (token) return req.headers['x-agent-runtime-token'] === token;
    return isLoopback(req.socket.remoteAddress);
  };

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/metrics') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      void metrics.registry
        .metrics()
        .then((text) => {
          res.writeHead(200, { 'content-type': metrics.registry.contentType });
          res.end(text);
        })
        .catch((err: unknown) => {
          logger.error({ msg: 'metrics_render_failed', err });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'metrics_unavailable' }));
        });
      return;
    }

    if (req.method === 'GET' && /^\/metrics\/summary(?:\?|$)/.test(req.url ?? '')) {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const raw = Number(url.searchParams.get('windowMinutes') ?? '15');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metrics.summary(raw)));
      return;
    }

    if (req.method === 'POST' && req.url === '/runs') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      let bytes = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        bytes += chunk.length;
        if (bytes > MAX_RUN_BODY_BYTES) {
          tooLarge = true;
          body = '';
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (tooLarge) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload_too_large' }));
          return;
        }
        let runReq: RunRequest;
        try {
          runReq = JSON.parse(body || '{}') as RunRequest;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
        // 续跑载荷会直接拼进模型历史，必须在写 SSE 头之前拒绝错型：
        // 否则错误会以 200 流的形式出现，BFF 只能等到超时或模型 400 才发现。
        if (runReq.resume !== undefined && !isValidResume(runReq.resume)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_resume' }));
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // 立即下发响应头：Node 默认要等第一次写 body 才发送头部，而首个模型事件
        // 可能要等十几秒（多模态/长思考）。BFF 的 10s 建连超时只应约束建连，
        // 不 flush 会让「等待首 token」被误判为上游不可达并中断整个运行。
        res.flushHeaders();

        // 每个运行一个中止控制器。同一 runId 被复用/重试时新控制器覆盖旧条目，
        // 旧运行退出前会比对身份，不会误删新运行的控制器。
        const controller = new AbortController();
        controllers.set(runReq.runId, controller);

        // 只放稳定 ID；prompt、消息与工具参数不进 span。
        const runAttributes: Record<string, string> = { 'run.id': runReq.runId };
        if (runReq.sessionId) runAttributes['session.id'] = runReq.sessionId;
        if (runReq.tenantId) runAttributes['tenant.id'] = runReq.tenantId;
        if (runReq.userId) runAttributes['enduser.id'] = runReq.userId;
        // 续接 BFF 注入的父上下文；没有 traceparent 时 startSpan 自建 root。
        const parent = extractTraceContext(req.headers);
        const runSpan = startSpan('runtime.run', runAttributes, {
          parent,
          kind: SpanKind.SERVER,
        });
        const spanContext = trace.setSpan(parent, runSpan);
        const runStartedAt = Date.now();
        let finalized = false;
        // 推理期间可能长时间没有任何事件：定期发 SSE 注释帧保活，避免中间代理
        // 或 BFF 的空闲超时把仍在正常工作（只是在等模型）的长连接当成卡死断开。
        const heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
        }, 15_000);
        heartbeat.unref?.();
        // SSE 断开即视为运行结束：同步收尾 span 与活跃计数，避免长连接泄漏。
        const finalizeRun = (ok: boolean, err?: unknown): void => {
          if (finalized) return;
          finalized = true;
          clearInterval(heartbeat);
          endSpan(runSpan, ok, err);
          metrics.runFinished();
          const fields = {
            msg: 'run_done',
            runId: runReq.runId,
            status: ok ? 'done' : 'failed',
            durationMs: Date.now() - runStartedAt,
          };
          if (ok) logger.info(fields);
          else logger.error({ ...fields, err: err ?? new Error('stream_closed') });
        };
        metrics.runStarted();
        logger.info({ msg: 'run_start', runId: runReq.runId });

        // 客户端断开：先中止执行循环（不再发起模型/工具调用），
        // 再把该 run 的挂起闸门按拒绝兑现，避免悬停到超时。
        res.on('close', () => {
          controller.abort();
          confirm.cancel(runReq.runId);
          finalizeRun(false);
        });

        context.with(spanContext, () =>
          runWithContext(
            {
              runId: runReq.runId,
              sessionId: runReq.sessionId,
              tenantId: runReq.tenantId,
              userId: runReq.userId,
            },
            () => {
              void (async () => {
                try {
                  // 助手技能只约束内置工具；账号级连接器（MCP）由用户在连接器页单独启停。
                  const enabledBase = filterTools(baseTools, runReq.enabledTools);
                  // 技能包文件按本次绑定动态挂载：未绑定技能时连工具都不出现。
                  const skillTools =
                    runReq.skills && runReq.skills.some((skill) => (skill.files?.length ?? 0) > 0)
                      ? [createSkillReadTool(runReq.skills)]
                      : [];
                  const runTools = extraTools
                    ? [...enabledBase, ...skillTools, ...(await extraTools(runReq.tenantId))]
                    : [...enabledBase, ...skillTools];
                  const config = resolveRunConfig(runReq.config, process.env);
                  // 本次运行优先使用 BFF 下发的厂商路由；缺省沿用启动网关。
                  const runGateway =
                    createGatewayFromRoutes(runReq.modelRoutes, observer) ?? gateway;
                  let sawArtifact = false;
                  let finalText = '';
                  let lastSeq = -1;
                  for await (const ev of runAgent(runReq, {
                    gateway: runGateway,
                    tools: runTools,
                    confirm,
                    maxRounds: config.maxRounds,
                    confirmTimeoutMs: config.confirmTimeoutMs,
                    codeExecTimeoutMs: config.codeExecTimeoutMs,
                    billing: runReq.billing,
                    signal: controller.signal,
                    onToolCall: (obs) => recordToolObservation(metrics, logger, obs),
                    onUsage: (u) => res.write(encodeSse({ event: 'usage', data: u })),
                    // checkpoint 只给 BFF 落库用；客户端已断开时静默丢弃，
                    // 避免向已 end 的响应写数据触发 EPIPE。
                    onCheckpoint: (cp) => {
                      if (!res.writableEnded && !res.destroyed) {
                        res.write(encodeSse({ event: 'checkpoint', data: cp }));
                      }
                    },
                  })) {
                    if (ev.type === 'artifact') sawArtifact = true;
                    if (ev.type === 'think') finalText = String(ev.payload.text ?? '');
                    lastSeq = ev.seq;
                    res.write(encodeSse({ event: 'step', data: ev }));
                  }
                  // 任务/编码模式的成果区不允许为空：模型一个文件都没产出时，
                  // 把最终回答兜底保存为 Markdown，至少留下可下载的结果文件。
                  if (
                    !sawArtifact &&
                    (runReq.mode === 'task' || runReq.mode === 'code') &&
                    finalText.trim()
                  ) {
                    try {
                      const ev = await writeFallbackArtifact(storage, runReq, finalText, lastSeq + 1);
                      res.write(encodeSse({ event: 'step', data: ev }));
                    } catch (err) {
                      // 对象存储故障不应把已完成的运行判为失败。
                      logger.warn({ msg: 'fallback_artifact_failed', runId: runReq.runId, err });
                    }
                  }
                  res.write(encodeSse({ event: 'done', data: { runId: runReq.runId } }));
                  finalizeRun(true);
                } catch (err) {
                  // 客户端已断开时 res.write 可能抛错；只按失败收尾，不再二次写流。
                  if (!finalized) {
                    res.write(encodeSse({ event: 'error', data: { message: String(err) } }));
                  }
                  finalizeRun(false, err);
                } finally {
                  // 只在仍是自己时删条目，避免覆盖同 runId 的新运行。
                  if (controllers.get(runReq.runId) === controller) {
                    controllers.delete(runReq.runId);
                  }
                  res.end();
                }
              })();
            },
          ),
        );
      });
      return;
    }

    const confirmMatch = req.method === 'POST' && /^\/runs\/([^/]+)\/confirm$/.exec(req.url ?? '');
    if (confirmMatch) {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const runId = decodeURIComponent(confirmMatch[1]);
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let decision: { confirmId?: unknown; approved?: unknown };
        try {
          decision = JSON.parse(body || '{}') as typeof decision;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
        if (
          typeof decision.confirmId !== 'string' ||
          decision.confirmId === '' ||
          typeof decision.approved !== 'boolean'
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_decision' }));
          return;
        }
        // runtime 无 run 注册表，区分不了「未知 run」与「已决」；二者统一 matched:false（幂等安全）。
        const matched = confirm.resolve(runId, decision.confirmId, decision.approved);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, matched }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/embed') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      let bytes = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        bytes += chunk.length;
        if (bytes > MAX_EMBED_BODY_BYTES) {
          tooLarge = true;
          body = '';
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        void (async () => {
          if (tooLarge) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'payload_too_large' }));
            return;
          }
          let texts: unknown;
          try {
            const parsed: unknown = JSON.parse(body || '{}');
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('not_object');
            }
            texts = (parsed as { texts?: unknown }).texts;
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_params' }));
            return;
          }
          if (
            !Array.isArray(texts) ||
            texts.length < 1 ||
            texts.length > EMBED_MAX_TEXTS ||
            !texts.every(
              (t) => typeof t === 'string' && t !== '' && countChars(t) <= EMBED_MAX_TEXT_CHARS,
            )
          ) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_params' }));
            return;
          }
          const total = (texts as string[]).reduce((sum, t) => sum + countChars(t), 0);
          if (total > EMBED_MAX_TOTAL_CHARS) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_params' }));
            return;
          }
          try {
            const vectors = await embedding.embed(texts as string[]);
            // 条数或维度不符时不能把坏向量交给 BFF 写库，直接按上游故障拒绝。
            if (
              vectors.length !== texts.length ||
              vectors.some((v) => v.length !== embedding.dim)
            ) {
              throw new Error('embedding_dim_mismatch');
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ vectors, dim: embedding.dim, model: embedding.model ?? 'unknown' }),
            );
          } catch (err) {
            logger.error({ msg: 'embed_failed', err });
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'embedding_failed' }));
          }
        })();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/kb/ingest') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        void (async () => {
          let payload: {
            storageKey?: unknown;
            filename?: unknown;
            mime?: unknown;
            chunkSize?: unknown;
            chunkOverlap?: unknown;
          };
          try {
            const parsed: unknown = JSON.parse(body || '{}');
            // 非对象（含字面量 null / 数组 / 标量）一律视为非法体，避免后续取属性抛错逃出保护块。
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('not_object');
            }
            payload = parsed as {
              storageKey?: unknown;
              filename?: unknown;
              mime?: unknown;
              chunkSize?: unknown;
              chunkOverlap?: unknown;
            };
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
          }
          const storageKey = String(payload.storageKey ?? '');
          const filename = String(payload.filename ?? '');
          const mime = typeof payload.mime === 'string' ? payload.mime : undefined;
          if (!storageKey || !filename) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'missing_params' }));
            return;
          }
          try {
            const stream = await storage.getObjectStream(storageKey);
            const chunks: Buffer[] = [];
            for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
            const data = Buffer.concat(chunks);
            const chunkConfig = resolveChunkConfig(payload, process.env);
            const out = await ingest(
              { data, filename, mime },
              { embed: embedding },
              chunkConfig,
            );
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, chunks: out }));
          } catch (err) {
            // 摄取失败是预期内业务结果（异步、前端轮询可见），回 200 + ok:false，不当作传输错误。
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        })();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/connectors/validate') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        void (async () => {
          let payload: { command?: unknown; args?: unknown; env?: unknown };
          try {
            const parsed: unknown = JSON.parse(body || '{}');
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('not_object');
            }
            payload = parsed as typeof payload;
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
          }
          const command = typeof payload.command === 'string' ? payload.command : '';
          const args =
            Array.isArray(payload.args) && payload.args.every((a) => typeof a === 'string')
              ? payload.args
              : [];
          const env = isStringRecord(payload.env) ? payload.env : {};
          if (!command) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'missing_command' }));
            return;
          }
          try {
            const tools: McpToolInfo[] = await validateConn(
              { command, args, env },
              { initTimeoutMs: Number(process.env.MCP_INIT_TIMEOUT_MS ?? 10000) },
            );
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, tools }));
          } catch (err) {
            // 校验失败是预期内业务结果，回 200 + ok:false，由 BFF 映射为 400。
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        })();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.on('close', () => void mcpHost?.closeAll());
  return server;
}

/** 工具观测转指标；MCP 工具名 `mcp.<server>.<tool>` 拆出 server 维度。 */
function recordToolObservation(
  metrics: RuntimeMetrics,
  logger: Logger,
  obs: ToolObservation,
): void {
  metrics.recordToolCall(obs.tool, obs.status, obs.durationMs);
  if (obs.tool.startsWith('mcp.')) {
    const rest = obs.tool.slice(4);
    const dot = rest.indexOf('.');
    if (dot > 0) {
      metrics.recordMcpToolCall(rest.slice(0, dot), rest.slice(dot + 1), obs.status);
    }
  }
  if (obs.codeExecTimeout) metrics.recordCodeExecTimeout();
  // 只记录工具名、状态与耗时：入参与结果全文禁止进日志。
  logger.debug({
    msg: 'tool_call',
    tool: obs.tool,
    status: obs.status,
    durationMs: obs.durationMs,
  });
}

/** 兜底产物：任务/编码模式没有任何成果文件时，把最终回答保存为可下载的 Markdown。 */
async function writeFallbackArtifact(
  storage: Storage,
  req: RunRequest,
  text: string,
  seq: number,
): Promise<AgentEvent> {
  const filename = req.mode === 'code' ? '代码结果.md' : '任务结果.md';
  const { artifact } = await emit(
    storage,
    { tenantId: req.tenantId, userId: req.userId, sessionId: req.sessionId, runId: req.runId },
    'text',
    filename,
    Buffer.from(text, 'utf8'),
  );
  return { runId: req.runId, seq, type: 'artifact', payload: { ...artifact }, ts: Date.now() };
}

/**
 * 严格校验 BFF 下发的续跑指令。
 * deltas 会原样拼进模型历史、usage 会并入计费累计值，任一字段错型都可能
 * 让运行在中途才失败或算错账，因此在这里一次性拦下（非法值整单拒绝）。
 */
export function isValidResume(v: unknown): v is RunResume {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  // round/seq 最终落 Prisma Int；seq 还会后自增，越界会在落库时才炸。
  if (!isIntInRange(r.round) || !isIntInRange(r.seq)) return false;
  if (!Array.isArray(r.deltas)) return false;
  // 待配对的 assistant toolCall id：checkpoint 只在完整轮后发出，
  // 因此回放历史里每个 tool 结果都必须有对应的 assistant 调用，反之亦然。
  const pending = new Set<string>();
  for (const raw of r.deltas) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const delta = raw as Record<string, unknown>;
    if (typeof delta.content !== 'string') return false;
    if (delta.role === 'assistant') {
      // 工具调用必须紧邻其 tool 结果：上一轮调用还未配对时又来了 assistant，
      // 真实 provider 会拒绝这段历史。agent loop 也只在结果补齐后才发下一条 assistant，
      // 因此这里出现插队 assistant 只可能是载荷被破坏或伪造。
      if (pending.size > 0) return false;
      // assistant 只承载调用，不能带 toolCallId；否则会伪装成工具结果破坏往返结构。
      if (delta.toolCallId !== undefined) return false;
      if (delta.toolCalls !== undefined) {
        if (!Array.isArray(delta.toolCalls)) return false;
        for (const rawCall of delta.toolCalls) {
          if (rawCall === null || typeof rawCall !== 'object' || Array.isArray(rawCall)) {
            return false;
          }
          const call = rawCall as Record<string, unknown>;
          if (typeof call.id !== 'string' || call.id === '') return false;
          if (typeof call.name !== 'string' || call.name === '') return false;
          if (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) {
            return false;
          }
          // 同一 id 未配对前再次出现，说明历史已被破坏或伪造。
          if (pending.has(call.id)) return false;
          pending.add(call.id);
        }
      }
    } else if (delta.role === 'tool') {
      // tool 只承载结果：必须带 id，且不能反过来携带 toolCalls。
      if (delta.toolCalls !== undefined) return false;
      if (typeof delta.toolCallId !== 'string' || delta.toolCallId === '') return false;
      if (!pending.has(delta.toolCallId)) return false;
      pending.delete(delta.toolCallId);
    } else {
      return false;
    }
  }
  // 有调用却没有结果，说明载荷不是完整轮落的 checkpoint，不能进入模型历史。
  if (pending.size > 0) return false;
  if (!Array.isArray(r.usage)) return false;
  for (const raw of r.usage) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.model !== 'string' || entry.model.trim() === '') return false;
    if (!isFiniteNonNegative(entry.input) || !isFiniteNonNegative(entry.output)) return false;
  }
  return true;
}

/**
 * 逻辑序号上限。Prisma Int 最大 2147483647，这里留约 1.47 亿余量：
 * 续跑一个工具轮会连续自增多步（每调用至少 tool_call + tool_result），
 * 只留 1 位会在落库时溢出；20 亿既能容纳正常运行，又能拒绝明显异常/伪造的巨值。
 */
const MAX_INT_SEQ = 2_000_000_000;

function isIntInRange(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_INT_SEQ;
}

/** 用量必须是有限非负数：NaN/Infinity 会污染预算计算与结算金额。 */
function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 按 Unicode 码点计数：中文与 emoji 各算 1，与 BFF 侧预算口径一致。 */
function countChars(text: string): number {
  return Array.from(text).length;
}

/** 判断请求来源是否为回环地址；未配置共享密钥时仅信任本机调用。 */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  // 双栈 socket 上 Node 把 IPv4 呈现为 ::ffff:127.0.0.1。
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return addr === '::1' || addr.startsWith('127.');
}

/** 解析 KB 切分参数：请求值非法时回落 env/默认；overlap 必须小于 size。 */
export function resolveChunkConfig(
  payload: { chunkSize?: unknown; chunkOverlap?: unknown },
  env: NodeJS.ProcessEnv,
): { chunkSize: number; chunkOverlap: number } {
  const int = (raw: unknown, min: number, max: number, fallback: number): number =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max
      ? raw
      : fallback;

  // Number('') === 0，空/空白 env 必须视为未设置，否则 KB_CHUNK_OVERLAP= 会静默变成 0。
  const envInt = (name: string, min: number, max: number, fallback: number): number => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? fallback : int(Number(raw), min, max, fallback);
  };

  const chunkSize = int(payload.chunkSize, 100, 4000, envInt('KB_CHUNK_SIZE', 100, 4000, 800));
  const requestedOverlap = int(
    payload.chunkOverlap,
    0,
    1000,
    envInt('KB_CHUNK_OVERLAP', 0, 1000, 150),
  );
  const chunkOverlap =
    requestedOverlap < chunkSize ? requestedOverlap : Math.min(150, Math.max(0, chunkSize - 1));
  return { chunkSize, chunkOverlap };
}

const isEntry = !!process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  loadRootEnv();
  initTelemetry({
    serviceName: 'ai-office-agent-runtime',
    serviceVersion: process.env.APP_VERSION ?? '0.0.0',
  });
  const storage = createStorage();
  try {
    await storage.ensureBucket();
  } catch (err) {
    console.warn(`ensureBucket 失败（文档工具将在运行期报错）: ${(err as Error).message}`);
  }
  // 独立端口变量：与 bff 的 PORT 分开，避免根 .env 里 PORT=4000 把 runtime 也顶到 4000。
  const port = Number(process.env.AGENT_RUNTIME_PORT ?? 4001);
  // 默认只绑本机；未配置 token 时仅回环来源可通过鉴权（fail-closed）。
  // 部署到网络时须显式设 AGENT_RUNTIME_HOST=0.0.0.0 并同时配置 AGENT_RUNTIME_TOKEN。
  const host = process.env.AGENT_RUNTIME_HOST ?? '127.0.0.1';
  const server = createRuntimeServer({ storage });
  server.listen(port, host, () => {
    console.log(`agent-runtime listening on http://${host}:${port}`);
  });
  // 收到终止信号时优雅停机：等待连接关闭后冲刷 span，再由事件循环自然退出。
  const shutdown = () => {
    server.close(() => void shutdownTelemetry());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * 按助手技能过滤内置工具：undefined 表示不限制（未绑定助手），
 * 空数组表示助手未勾选任何技能、禁用全部内置工具。未知工具名自然被丢弃。
 */
export function filterTools(tools: Tool[], enabled?: string[]): Tool[] {
  if (enabled === undefined) return tools;
  const allowed = new Set(enabled);
  return tools.filter((t) => allowed.has(t.name));
}

/** 默认追加工具：拉启用连接器 → 构建 MCP 工具；BFF 不可达时降级为空。 */
function defaultExtraTools(host: McpHost): (tenantId: string) => Promise<Tool[]> {
  return async (tenantId: string): Promise<Tool[]> => {
    try {
      const connectors = await fetchConnectors(
        {
          baseUrl: process.env.BFF_INTERNAL_URL ?? 'http://localhost:4000',
          internalToken: process.env.INTERNAL_TOKEN,
        },
        tenantId,
      );
      // 只回收本租户的进程：池按 (tenantId, name) 隔离，避免一个租户的 run
      // 关闭其他租户正在使用的 MCP 子进程。
      await host.retain(tenantId, new Set(connectors.filter((c) => c.enabled).map((c) => c.name)));
      return await buildMcpTools(tenantId, connectors, host);
    } catch {
      // 拉取失败退化为无 MCP 工具，不中断本次 run。
      return [];
    }
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
  );
}
