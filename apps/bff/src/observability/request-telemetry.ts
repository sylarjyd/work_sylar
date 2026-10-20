import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { context, SpanKind, trace, type Span } from '@opentelemetry/api';
import { endSpan, extractTraceContext, runWithContext } from '@ai-office/telemetry';
import type { Logger } from 'pino';
import type { BffMetrics } from './observability.metrics';

const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const tracer = () => trace.getTracer('ai-office');

interface State {
  span: Span;
  started: bigint;
  requestId: string;
  route: string;
  method: string;
  finalize: () => void;
}

const states = new WeakMap<FastifyRequest, State>();

export function sanitizeRequestId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : null;
}

function pathOf(req: FastifyRequest): string {
  return (req.url ?? '/').split('?')[0] ?? '/';
}

function routeOf(req: FastifyRequest): string {
  const opts = (req as FastifyRequest & { routeOptions?: { url?: string } }).routeOptions;
  return opts?.url ?? 'unmatched';
}

function isInternal(url: string | undefined): boolean {
  const path = (url ?? '/').split('?')[0] ?? '/';
  return path === '/metrics' || path.startsWith('/api/health');
}

/**
 * 请求生命周期：onRequest 开 SERVER span 并绑定 ALS；收尾挂在 raw 的 finish/close 上。
 * 不能只依赖 onResponse：SSE 路由 hijack 后由控制器直接写 raw，且客户端断开时
 * 同样必须结束 span、记录指标与访问日志。onResponse 作为普通请求的兜底，finalize 幂等。
 */
export function registerRequestTelemetry(
  app: FastifyInstance,
  metrics: BffMetrics,
  logger: Logger,
): void {
  app.addHook('onRequest', (req, reply, done) => {
    try {
      const requestId = sanitizeRequestId(req.headers['x-request-id']) ?? randomUUID();
      req.headers['x-request-id'] = requestId;
      reply.raw.setHeader('x-request-id', requestId);
      const route = routeOf(req);
      const parent = extractTraceContext(req.headers);
      const span = tracer().startSpan(
        `${req.method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': req.method,
            'url.path': pathOf(req),
            'http.route': route,
          },
        },
        parent,
      );
      const state: State = {
        span,
        started: process.hrtime.bigint(),
        requestId,
        route,
        method: req.method,
        finalize: () => undefined,
      };
      states.set(req, state);

      let finalized = false;
      state.finalize = (): void => {
        if (finalized) return;
        finalized = true;
        try {
          const status = reply.raw.statusCode || reply.statusCode;
          const durationMs = Number(process.hrtime.bigint() - state.started) / 1e6;
          const sc = state.span.spanContext();
          state.span.setAttribute('http.response.status_code', status);
          endSpan(state.span, status < 500);
          if (isInternal(req.url)) return;
          metrics.httpRequests.inc({
            method: state.method,
            route: state.route,
            status: String(status),
          });
          metrics.httpDuration.observe(
            { method: state.method, route: state.route },
            durationMs / 1000,
          );
          const fields = {
            msg: 'http_request',
            method: state.method,
            route: state.route,
            status,
            durationMs: Math.round(durationMs),
            requestId: state.requestId,
            traceId: sc.traceId,
          };
          if (status >= 500) logger.error(fields);
          else if (status >= 400) logger.warn(fields);
          else logger.info(fields);
        } catch {
          // 可观测性收尾失败不能影响已结束的响应。
        }
      };
      reply.raw.once('finish', state.finalize);
      reply.raw.once('close', state.finalize);

      const ctx = trace.setSpan(parent, span);
      context.with(ctx, () => runWithContext({ requestId }, () => done()));
    } catch {
      done();
    }
  });

  app.addHook('onResponse', (req, _reply, done) => {
    states.get(req)?.finalize();
    done();
  });
}
