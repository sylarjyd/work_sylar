import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export type SpanAttributes = Record<string, string | number | boolean>;
export type HeaderCarrier = Record<string, string | string[] | undefined>;

export interface InitOptions {
  serviceName: string;
  serviceVersion: string;
  environment?: string;
}

export interface TraceIds {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

let provider: NodeTracerProvider | null = null;
let shuttingDown: Promise<void> | null = null;

/**
 * 必须在调用时取 tracer：模块加载早于 initTelemetry，OTel 的 ProxyTracer 首次
 * 解析不到 provider 时会永久缓存 NoopTracer，提前捕获会让后续所有 span 变成空操作。
 */
function tracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer('ai-office');
}

function toOtelAttributes(attrs: SpanAttributes = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function otlpTracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

/** OTel 2.x 推荐手动装配；未配置 OTLP 端点时不导出任何 span。初始化失败必须 fail-open。 */
export function initTelemetry(options: InitOptions): void {
  if (provider) return;
  try {
    const manager = new AsyncLocalStorageContextManager();
    manager.enable();
    context.setGlobalContextManager(manager);

    const rawRatio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1.0');
    const ratio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 1;
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    const processors = endpoint
      ? [
          new BatchSpanProcessor(
            new OTLPTraceExporter({
              url: otlpTracesUrl(endpoint),
              headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
            }),
          ),
        ]
      : [];

    const next = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.serviceVersion,
        'deployment.environment':
          options.environment ?? process.env.NODE_ENV ?? 'development',
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
      spanProcessors: processors,
    });
    next.register({ propagator: new W3CTraceContextPropagator() });
    provider = next;
  } catch (err) {
    console.error(`[telemetry] 初始化失败，已降级为 no-op: ${(err as Error).message}`);
    provider = null;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return;
  if (!shuttingDown) {
    const current = provider;
    shuttingDown = current
      .shutdown()
      .catch((err: unknown) => {
        console.error(`[telemetry] 关闭失败: ${(err as Error).message}`);
      })
      .then(() => {
        provider = null;
        shuttingDown = null;
      });
  }
  await shuttingDown;
}

export function currentTrace(): TraceIds | null {
  const span = trace.getSpan(context.active());
  if (!span) return null;
  const sc = span.spanContext();
  if (!sc.traceId || !sc.spanId || sc.traceId === '00000000000000000000000000000000') {
    return null;
  }
  return {
    traceId: sc.traceId,
    spanId: sc.spanId,
    sampled: (sc.traceFlags & TraceFlags.SAMPLED) !== 0,
  };
}

function toCarrier(headers: HeaderCarrier): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') {
      out[key.toLowerCase()] = value[0];
    }
  }
  return out;
}

export function extractTraceContext(headers: HeaderCarrier): Context {
  return propagation.extract(context.active(), toCarrier(headers));
}

export function extractTraceparent<T>(headers: HeaderCarrier, fn: () => T): T {
  return context.with(extractTraceContext(headers), fn);
}

export function injectTraceparent(
  headers: Record<string, string>,
  span?: Span,
): Record<string, string> {
  const carrier: Record<string, string> = {};
  const source = span ? trace.setSpan(context.active(), span) : context.active();
  propagation.inject(source, carrier);
  if (carrier.traceparent) headers.traceparent = carrier.traceparent;
  return headers;
}

export function startSpan(
  name: string,
  attributes: SpanAttributes = {},
  options: { parent?: Context; kind?: SpanKind } = {},
): Span {
  return tracer().startSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: toOtelAttributes(attributes) },
    options.parent,
  );
}

export function endSpan(span: Span, ok: boolean, err?: unknown): void {
  if (!ok) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (err !== undefined) {
      span.recordException(err instanceof Error ? err : String(err));
    }
  }
  span.end();
}

export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  const span = startSpan(name, attributes);
  const ctx = trace.setSpan(context.active(), span);
  try {
    return await context.with(ctx, () => fn(span));
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.recordException(err instanceof Error ? err : String(err));
    throw err;
  } finally {
    span.end();
  }
}

export function addSpanAttributes(attributes: SpanAttributes): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [key, value] of Object.entries(toOtelAttributes(attributes))) {
    span.setAttribute(key, value);
  }
}
