# M5b-2 可观测性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 web → BFF → runtime 补齐结构化日志、W3C 全链路 trace、Prometheus 指标、小时快照、管理端运行概览/时间线与可配置 Webhook 告警。

**Architecture:** 新增 Node-only `packages/telemetry`，以 OTel 2.x 手动装配（`NodeTracerProvider` + OTLP/HTTP 可选导出）、pino 与 prom-client 为三进程提供统一能力。BFF 负责请求 span/日志/指标、run 埋点、快照与告警；runtime 负责 run/模型/工具 span 与内存指标摘要；web 只生成并注入 `traceparent`/`x-request-id`。快照与告警用 Redis 选主，`MetricBucket` upsert 与 `AlertEvent.openKey` 唯一约束兜底多实例幂等。

**Tech Stack:** TypeScript 5.6、Node 22、OTel API 1.9 / SDK 2.12 / OTLP 0.223、pino 10、prom-client 15、NestJS 10 + Fastify 4、Prisma 6 + PostgreSQL 16、ioredis 5、Vitest 2、Next.js 15 / React 19。

---

## 约定（每个 Task 都适用）

- 直接在当前 `master` 分支开发，不建特性分支、不建 worktree。
- 注释与 commit message 一律中文；commit 格式 `type(scope): 中文摘要`，正文写「为什么改」，不要罗列文件。
- 严格 TDD：先写失败测试 → 运行确认失败 → 写最小实现 → 再跑通过 → 提交。
- 每完成一个 Task 跑该 Task 指定测试并提交；Task 13 统一跑 `pnpm test` 与 `pnpm build`。
- 下游包通过 `@ai-office/shared` 的 `dist` 解析类型：每次改完 `packages/shared/src` 都要先执行 `pnpm --filter @ai-office/shared build`，否则测试/typecheck 读到的是旧声明。
- 所有时间字段为 UTC ISO；禁止把 prompt、消息正文、工具入参/结果全文、Authorization、内部 token、API key、连接器 env、Webhook secret 写入日志或指标 label。
- 指标 label 禁止 `userId/tenantId/sessionId/runId`；模型/工具名必须经 `boundedLabel` 截断。
- 测试默认不启动真实定时器、不访问真实 Redis/OTLP/Runtime；通过注入锁、时钟、fetch 桩隔离。

## File Structure

### 新增

```
packages/telemetry/
  package.json
  tsconfig.json
  src/index.ts                 # 公共导出
  src/context.ts               # AsyncLocalStorage 请求上下文
  src/trace.ts                 # 初始化、span、traceparent、shutdown
  src/logger.ts                # pino 工厂、mixin、redact
  src/metrics.ts               # Registry、桶、boundedLabel
  src/trace.test.ts
  src/logger.test.ts
  src/metrics.test.ts

apps/bff/src/observability/
  observability.metrics.ts     # BFF 指标定义与 BFF_METRICS token
  observability-access.ts      # 回环或内部 token 鉴权
  observability.module.ts
  request-telemetry.ts         # Fastify onRequest/onResponse 钩子
  app-logger.ts                # Nest LoggerService → pino
  metrics.controller.ts        # GET /metrics
  health.service.ts            # DB/Redis/runtime 探测
  health.controller.ts         # /api/health、/api/health/ready
  run-telemetry.ts             # run 指标收尾与模型成本分摊
  run-telemetry.test.ts
  request-telemetry.test.ts
  health.service.test.ts

apps/bff/src/metrics/
  rollup.ts                    # 纯聚合函数
  rollup.test.ts
  leader-lock.ts               # Redis SET NX PX 锁
  leader-lock.test.ts
  metrics.sweeper.ts
  metrics.sweeper.test.ts
  metrics.module.ts

apps/bff/src/alerts/
  alert-rules.ts               # 内置规则
  alert-format.ts              # 比较器与消息文案
  alert-format.test.ts
  runtime-summary.client.ts
  runtime-summary.client.test.ts
  alert-webhook.ts             # 签名/超时/重试/配额
  alert-webhook.test.ts
  alert-metrics.ts             # 指标读取
  alert-metrics.test.ts
  alert-evaluator.ts           # 事件状态机
  alert-evaluator.test.ts
  alert-sweeper.ts
  alert-sweeper.test.ts
  alerts.module.ts

apps/bff/src/admin/
  admin-observability.service.ts    # 概览与指标序列
  admin-observability.controller.ts
  admin-observability.service.test.ts
  run-timeline.ts                   # 纯时间线聚合
  run-timeline.test.ts
  admin-alerts.service.ts           # 规则/事件/测试投递
  admin-alerts.controller.ts
  admin-alerts.service.test.ts

apps/agent-runtime/src/observability/
  metrics.ts                   # runtime 指标 + 分钟摘要
  metrics.test.ts

apps/agent-runtime/src/model/observed-gateway.ts

apps/web/src/lib/trace.ts
apps/web/src/lib/run-timeline.ts
apps/web/src/lib/run-timeline.test.ts
apps/web/src/lib/alert-draft.ts
apps/web/src/lib/alert-draft.test.ts
apps/web/src/components/chart-geometry.ts
apps/web/src/components/chart-geometry.test.ts
apps/web/src/components/metric-chart.tsx
apps/web/src/app/admin/overview/page.tsx
apps/web/src/app/admin/alerts/page.tsx
```

### 修改

```
package.json / pnpm-lock.yaml                     # workspace 新包
apps/bff/package.json                             # 依赖 telemetry
apps/agent-runtime/package.json                   # 依赖 telemetry
apps/bff/prisma/schema.prisma                     # traceId、索引、快照/告警模型
packages/shared/src/dto.ts                        # 新增 DTO、AdminSettingDto 类型化
apps/bff/src/app.module.ts                        # 挂 Observability/Metrics/Alerts
apps/bff/src/main.ts                              # telemetry 初始化、日志、钩子、优雅退出
apps/bff/src/auth/jwt.guard.ts                    # 请求上下文与 span 属性
apps/bff/src/tasks/tasks.controller.ts            # traceparent、run 指标
apps/bff/src/tasks/tasks.service.ts               # Run.traceId
apps/bff/src/billing/billing.service.ts           # 限流命中计数
apps/bff/src/billing/billing.sweeper.ts           # 结算失败计数
apps/bff/src/settings/settings.service.ts         # 类型化参数
apps/bff/src/settings/settings.service.test.ts    # 新类型测试
apps/bff/src/admin/admin.module.ts                # 新控制器/服务
apps/bff/src/admin/admin-tasks.controller.ts      # timeline 路由
apps/bff/src/admin/admin-tasks.service.ts         # traceId + 时间线
apps/agent-runtime/src/server.ts                  # 初始化、/metrics、run span
apps/agent-runtime/src/agent-loop.ts              # 工具/模型 span 与指标
apps/agent-runtime/src/model/routing-gateway.ts   # attempt/fallback 观察者
apps/agent-runtime/src/model/create-gateway.ts    # 传入观察者
apps/agent-runtime/src/mcp/host.ts                # 重启回调
apps/web/src/lib/api.ts                           # 注入 trace 头
apps/web/src/lib/api.test.ts
apps/web/src/lib/admin-api.ts                     # 新增管理 API 与错误文案
apps/web/src/lib/admin-api.test.ts                # 新接口 URL/请求体测试
apps/web/src/components/admin-shell.tsx           # 导航
apps/web/src/app/admin/page.tsx                   # 默认跳 overview
apps/web/src/app/admin/tasks/page.tsx             # traceId + 时间线
apps/web/src/app/admin/settings/page.tsx          # 类型化输入
apps/web/src/app/globals.css                      # 看板/时间线样式
turbo.json / .env.example
docs/deploy/06-deployment.md
docs/develop/05-dev-plan.md
```

---

## Task 1: 新建 `packages/telemetry`

**Files:**
- Create: `packages/telemetry/package.json`
- Create: `packages/telemetry/tsconfig.json`
- Create: `packages/telemetry/src/context.ts`
- Create: `packages/telemetry/src/trace.ts`
- Create: `packages/telemetry/src/logger.ts`
- Create: `packages/telemetry/src/metrics.ts`
- Create: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/src/trace.test.ts`
- Test: `packages/telemetry/src/logger.test.ts`
- Test: `packages/telemetry/src/metrics.test.ts`

- [ ] **Step 1: 创建包清单与 tsconfig**

`packages/telemetry/package.json`：

```json
{
  "name": "@ai-office/telemetry",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "test": "vitest run"
  },
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/context-async-hooks": "^2.12.0",
    "@opentelemetry/core": "^2.12.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.223.0",
    "@opentelemetry/resources": "^2.12.0",
    "@opentelemetry/sdk-trace-base": "^2.12.0",
    "@opentelemetry/sdk-trace-node": "^2.12.0",
    "@opentelemetry/semantic-conventions": "^1.43.0",
    "pino": "^10.4.0",
    "pino-pretty": "^13.2.0",
    "prom-client": "^15.1.3"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/telemetry/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 2: 写失败测试**

`packages/telemetry/src/trace.test.ts`：

```ts
import { afterAll, describe, expect, it } from 'vitest';
import {
  currentContext,
  currentTrace,
  extractTraceparent,
  initTelemetry,
  injectTraceparent,
  runWithContext,
  shutdownTelemetry,
  withSpan,
} from './index';

initTelemetry({ serviceName: 'telemetry-test', serviceVersion: '1.0.0' });

afterAll(async () => {
  await shutdownTelemetry();
});

describe('trace', () => {
  it('withSpan 生成有效 traceId，并能注入/提取 W3C traceparent', async () => {
    const traceId = await withSpan('root', { 'test.attr': 'v' }, async () => {
      const headers: Record<string, string> = {};
      injectTraceparent(headers);
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      const extracted = extractTraceparent(headers, () => currentTrace());
      expect(extracted?.traceId).toBe(currentTrace()?.traceId);
      return currentTrace()!.traceId;
    });
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('上下文在异步调用链中保持', async () => {
    await runWithContext({ requestId: 'req-1', userId: 'u1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentContext()).toMatchObject({ requestId: 'req-1', userId: 'u1' });
    });
  });

  it('非法 traceparent 不产生有效远端上下文', () => {
    const got = extractTraceparent({ traceparent: 'not-a-trace' }, () => currentTrace());
    expect(got).toBeNull();
  });
});
```

`packages/telemetry/src/logger.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger, runWithContext, withSpan } from './index';

function capture() {
  const lines: string[] = [];
  const destination: DestinationStream = {
    write(line: string) {
      lines.push(line);
    },
  };
  return { lines, destination };
}

describe('createLogger', () => {
  it('自动附加请求/trace 字段并脱敏', async () => {
    const { lines, destination } = capture();
    const logger = createLogger('svc', { destination, pretty: false, level: 'info' });
    await withSpan('root', {}, async () =>
      runWithContext({ requestId: 'rid', userId: 'u1', tenantId: 't1' }, () => {
        logger.info(
          {
            authorization: 'Bearer secret',
            nested: { apiKey: 'k-1', password: 'p' },
            message: 'hello',
          },
          'hello',
        );
      }),
    );
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.service).toBe('svc');
    expect(row.requestId).toBe('rid');
    expect(row.userId).toBe('u1');
    expect(row.tenantId).toBe('t1');
    expect(row.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(row.authorization).toBe('[redacted]');
    expect((row.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((row.nested as Record<string, unknown>).password).toBe('[redacted]');
  });

  it('无上下文时不写 undefined 字段', () => {
    const { lines, destination } = capture();
    const logger = createLogger('svc', { destination, pretty: false, level: 'info' });
    logger.info('plain');
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.msg).toBe('plain');
    expect(row.traceId).toBeUndefined();
    expect(row.requestId).toBeUndefined();
  });
});
```

`packages/telemetry/src/metrics.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { Counter } from 'prom-client';
import {
  boundedLabel,
  createMetricsRegistry,
  HTTP_DURATION_BUCKETS,
} from './index';

describe('metrics', () => {
  it('每个 Registry 独立且不注册全局默认指标', async () => {
    const a = createMetricsRegistry({ defaultMetrics: false });
    const b = createMetricsRegistry({ defaultMetrics: false });
    new Counter({ name: 'test_total', help: 't', registers: [a] });
    expect(await a.metrics()).toContain('test_total');
    expect(await b.metrics()).not.toContain('test_total');
  });

  it('boundedLabel 截断且稳定去重', () => {
    const long = `mcp.${'x'.repeat(100)}.tool`;
    const one = boundedLabel(long, 64);
    const two = boundedLabel(long, 64);
    expect(one).toHaveLength(64);
    expect(one).toBe(two);
    expect(boundedLabel('short')).toBe('short');
  });

  it('HTTP 桶与规范一致', () => {
    expect(HTTP_DURATION_BUCKETS).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
    ]);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm install
pnpm --filter @ai-office/telemetry test
```

Expected: FAIL，报错指出 `./index` 不存在或导出缺失。

- [ ] **Step 4: 实现 context.ts**

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TelemetryContext {
  requestId?: string;
  userId?: string;
  tenantId?: string;
  runId?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<TelemetryContext>();

export function currentContext(): TelemetryContext {
  return { ...(storage.getStore() ?? {}) };
}

export function runWithContext<T>(patch: TelemetryContext, fn: () => T): T {
  const next = { ...(storage.getStore() ?? {}), ...patch };
  return storage.run(next, fn);
}

/** 在当前上下文内就地补充字段（JwtGuard 鉴权后回填用户信息）。 */
export function updateContext(patch: TelemetryContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
```

- [ ] **Step 5: 实现 trace.ts**

```ts
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
const tracer = trace.getTracer('ai-office');

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
  return tracer.startSpan(
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
```

- [ ] **Step 6: 实现 logger.ts**

```ts
import pino, { type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context';
import { currentTrace } from './trace';

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  destination?: DestinationStream;
}

const REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-internal-token',
  'x-agent-runtime-token',
  'password',
  'passwordHash',
  'token',
  'apiKey',
  'secret',
  'webhookUrl',
  'env',
  '*.authorization',
  '*.cookie',
  '*.set-cookie',
  '*.x-internal-token',
  '*.x-agent-runtime-token',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.webhookUrl',
  '*.env',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
];

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const base = {
    service,
    env: process.env.NODE_ENV ?? 'development',
    version: process.env.APP_VERSION ?? '0.0.0',
  };
  const config: pino.LoggerOptions = {
    level,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin() {
      const trace = currentTrace();
      const ctx = currentContext();
      return {
        traceId: trace?.traceId,
        spanId: trace?.spanId,
        requestId: ctx.requestId,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
      };
    },
  };
  const pretty = options.pretty ?? process.env.LOG_PRETTY === '1';
  if (pretty && !options.destination) {
    return pino({
      ...config,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    });
  }
  return pino(config, options.destination);
}
```

- [ ] **Step 7: 实现 metrics.ts**

```ts
import { collectDefaultMetrics, Registry } from 'prom-client';

export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];
export const MODEL_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60];
export const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export interface RegistryOptions {
  defaultMetrics?: boolean;
}

/** 每个应用独立 Registry；测试传 defaultMetrics:false，避免默认指标污染断言。 */
export function createMetricsRegistry(options: RegistryOptions = {}): Registry {
  const registry = new Registry();
  if (options.defaultMetrics !== false) {
    collectDefaultMetrics({ register: registry, prefix: 'ai_office_' });
  }
  return registry;
}

/** 标签值截断到 max，尾部附稳定哈希，保证截断后仍可区分。 */
export function boundedLabel(value: string, max = 64): string {
  const limit = Math.max(9, max);
  if (value.length <= limit) return value;
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  const suffix = `#${hash.toString(16).padStart(8, '0')}`;
  return value.slice(0, limit - suffix.length) + suffix;
}
```

- [ ] **Step 8: 实现 index.ts**

```ts
export {
  currentContext,
  runWithContext,
  updateContext,
  type TelemetryContext,
} from './context';
export {
  addSpanAttributes,
  currentTrace,
  endSpan,
  extractTraceContext,
  extractTraceparent,
  initTelemetry,
  injectTraceparent,
  shutdownTelemetry,
  startSpan,
  withSpan,
  type HeaderCarrier,
  type InitOptions,
  type SpanAttributes,
  type TraceIds,
} from './trace';
export { createLogger, type LoggerOptions } from './logger';
export {
  boundedLabel,
  createMetricsRegistry,
  HTTP_DURATION_BUCKETS,
  MODEL_DURATION_BUCKETS,
  TOOL_DURATION_BUCKETS,
  type RegistryOptions,
} from './metrics';
```

- [ ] **Step 9: 运行测试与构建**

```bash
pnpm --filter @ai-office/telemetry test
pnpm --filter @ai-office/telemetry build
```

Expected: 3 个测试文件全部 PASS；`dist/index.js` 与 `dist/index.d.ts` 生成。

- [ ] **Step 10: 提交**

```bash
git add packages/telemetry pnpm-lock.yaml
git commit -m "feat(telemetry): 新增可观测性基础包

抽出跨 BFF/runtime 共用的 OTel、pino 与 prom-client 封装，避免两端各写一套
trace 传播、脱敏和指标注册逻辑；OTLP 未配置时不产生网络请求，初始化失败只降级，
保证可观测性故障不影响业务。"
```

---

## Task 2: BFF 接入请求追踪、日志、指标与健康检查

**Files:**
- Modify: `apps/bff/package.json`
- Create: `apps/bff/src/observability/observability.metrics.ts`
- Create: `apps/bff/src/observability/observability-access.ts`
- Create: `apps/bff/src/observability/request-telemetry.ts`
- Create: `apps/bff/src/observability/app-logger.ts`
- Create: `apps/bff/src/observability/metrics.controller.ts`
- Create: `apps/bff/src/observability/health.service.ts`
- Create: `apps/bff/src/observability/health.controller.ts`
- Create: `apps/bff/src/observability/observability.module.ts`
- Modify: `apps/bff/src/app.module.ts`
- Modify: `apps/bff/src/main.ts`
- Test: `apps/bff/src/observability/request-telemetry.test.ts`
- Test: `apps/bff/src/observability/health.service.test.ts`

- [ ] **Step 1: 加依赖**

`apps/bff/package.json` 的 `dependencies` 增加：

```json
"@ai-office/telemetry": "workspace:*",
```

- [ ] **Step 2: 补健康检查共享 DTO**

`packages/shared/src/dto.ts` 末尾追加：

```ts
export interface HealthCheckDto {
  ok: boolean;
  latencyMs?: number;
  /** Redis 未配置时标记为跳过，不视为失败。 */
  skipped?: boolean;
  error?: string;
}

export interface HealthReadyDto {
  status: 'ready' | 'degraded';
  version: string;
  checks: {
    db: HealthCheckDto;
    redis: HealthCheckDto;
    runtime: HealthCheckDto;
  };
}
```

构建立即生效的声明文件：

```bash
pnpm --filter @ai-office/shared build
```

Expected: `dist/index.d.ts` 中出现 `HealthReadyDto`。

- [ ] **Step 3: 写失败测试**

`apps/bff/src/observability/request-telemetry.test.ts`：

```ts
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import pino from 'pino';
import { initTelemetry, shutdownTelemetry } from '@ai-office/telemetry';
import { createBffMetrics } from './observability.metrics';
import { registerRequestTelemetry, sanitizeRequestId } from './request-telemetry';
import { observabilityAllowed } from './observability-access';

beforeAll(() => {
  initTelemetry({ serviceName: 'bff-test', serviceVersion: '1' });
});

afterAll(async () => {
  await shutdownTelemetry();
});

describe('request telemetry', () => {
  it('透传合法 request id，写响应头并记录 HTTP 指标', async () => {
    const app = Fastify();
    const metrics = createBffMetrics({ defaultMetrics: false });
    registerRequestTelemetry(app, metrics, pino({ level: 'silent' }));
    app.get('/x/:id', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/x/1?token=secret',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');

    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_http_requests_total');
    expect(text).toContain('route="/x/:id"');
    expect(text).toContain('status="200"');
    await app.close();
  });

  it('非法 request id 重新生成，健康/指标路径不计数', async () => {
    const app = Fastify();
    const metrics = createBffMetrics({ defaultMetrics: false });
    registerRequestTelemetry(app, metrics, pino({ level: 'silent' }));
    app.get('/api/health', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'bad id\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('route="/api/health"');
    await app.close();
  });

  it('request id 白名单', () => {
    expect(sanitizeRequestId('abc-DEF_1')).toBeNull();
    expect(sanitizeRequestId('abc-DEF-1')).toBe('abc-DEF-1');
    expect(sanitizeRequestId('x'.repeat(65))).toBeNull();
  });

  it('只有回环或内部 token 可访问', () => {
    const saved = process.env.INTERNAL_TOKEN;
    process.env.INTERNAL_TOKEN = 'secret';
    try {
      expect(
        observabilityAllowed({ ip: '127.0.0.1', headers: {} } as never),
      ).toBe(true);
      expect(
        observabilityAllowed({ ip: '10.0.0.1', headers: {} } as never),
      ).toBe(false);
      expect(
        observabilityAllowed({
          ip: '10.0.0.1',
          headers: { 'x-internal-token': 'secret' },
        } as never),
      ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_TOKEN;
      else process.env.INTERNAL_TOKEN = saved;
    }
  });
});
```

`apps/bff/src/observability/health.service.test.ts`：

```ts
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service';
import { createBffMetrics } from './observability.metrics';

function service(dbOk = true, runtimeOk = true) {
  const prisma = {
    $queryRaw: dbOk ? vi.fn().mockResolvedValue([{ '?column?': 1 }]) : vi.fn().mockRejectedValue(new Error('db down')),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!runtimeOk) throw new Error('runtime down');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return new HealthService(prisma as never, createBffMetrics({ defaultMetrics: false }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REDIS_URL;
});

describe('HealthService', () => {
  it('DB/runtime 正常且 Redis 未配置时 ready，Redis 标记 skipped', async () => {
    const out = await service().ready();
    expect(out.status).toBe('ready');
    expect(out.checks.db).toMatchObject({ ok: true });
    expect(out.checks.redis).toMatchObject({ ok: true, skipped: true });
    expect(out.checks.runtime).toMatchObject({ ok: true });
  });

  it('任一关键依赖失败时 degraded，并置 service_up=0', async () => {
    const svc = service(false, false);
    const out = await svc.ready();
    expect(out.status).toBe('degraded');
    expect(out.checks.db.ok).toBe(false);
    expect(out.checks.runtime.ok).toBe(false);
    const text = await svc.metrics.registry.metrics();
    expect(text).toContain('ai_office_service_up{service="db"} 0');
    expect(text).toContain('ai_office_service_up{service="runtime"} 0');
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm install
pnpm --filter @ai-office/bff test -- src/observability/request-telemetry.test.ts src/observability/health.service.test.ts
```

Expected: FAIL，报 `Cannot find module './observability.metrics'` 等。

- [ ] **Step 5: 实现指标定义**

`apps/bff/src/observability/observability.metrics.ts`：

```ts
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import {
  createMetricsRegistry,
  HTTP_DURATION_BUCKETS,
  MODEL_DURATION_BUCKETS,
} from '@ai-office/telemetry';

export const BFF_METRICS = Symbol('BFF_METRICS');

export interface BffMetrics {
  registry: Registry;
  httpRequests: Counter;
  httpDuration: Histogram;
  runsTotal: Counter;
  runDuration: Histogram;
  activeRuns: Gauge;
  modelTokens: Counter;
  modelCredits: Counter;
  billingSettleFailures: Counter;
  rateLimitHits: Counter;
  alertsFired: Counter;
  alertEvalFailures: Counter;
  rollupFailures: Counter;
  serviceUp: Gauge;
}

export function createBffMetrics(
  options: { defaultMetrics?: boolean } = {},
): BffMetrics {
  const registry = createMetricsRegistry(options);
  return {
    registry,
    httpRequests: new Counter({
      name: 'ai_office_http_requests_total',
      help: 'BFF HTTP 请求数',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'ai_office_http_request_duration_seconds',
      help: 'BFF HTTP 请求耗时',
      labelNames: ['method', 'route'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [registry],
    }),
    runsTotal: new Counter({
      name: 'ai_office_runs_total',
      help: '运行终态数量',
      labelNames: ['status'],
      registers: [registry],
    }),
    runDuration: new Histogram({
      name: 'ai_office_run_duration_seconds',
      help: '运行总耗时',
      buckets: MODEL_DURATION_BUCKETS,
      registers: [registry],
    }),
    activeRuns: new Gauge({
      name: 'ai_office_active_runs',
      help: '进行中的运行数',
      registers: [registry],
    }),
    modelTokens: new Counter({
      name: 'ai_office_model_tokens_total',
      help: '模型 token 用量',
      labelNames: ['model', 'type'],
      registers: [registry],
    }),
    modelCredits: new Counter({
      name: 'ai_office_model_credits_total',
      help: '按模型分摊的积分',
      labelNames: ['model'],
      registers: [registry],
    }),
    billingSettleFailures: new Counter({
      name: 'ai_office_billing_settle_failures_total',
      help: '结算失败次数',
      registers: [registry],
    }),
    rateLimitHits: new Counter({
      name: 'ai_office_rate_limit_hits_total',
      help: '限流命中次数',
      labelNames: ['scope'],
      registers: [registry],
    }),
    alertsFired: new Counter({
      name: 'ai_office_alerts_fired_total',
      help: '告警触发次数',
      labelNames: ['severity'],
      registers: [registry],
    }),
    alertEvalFailures: new Counter({
      name: 'ai_office_alert_eval_failures_total',
      help: '告警评估失败次数',
      registers: [registry],
    }),
    rollupFailures: new Counter({
      name: 'ai_office_rollup_failures_total',
      help: '快照失败次数',
      registers: [registry],
    }),
    serviceUp: new Gauge({
      name: 'ai_office_service_up',
      help: '依赖服务健康状态',
      labelNames: ['service'],
      registers: [registry],
    }),
  };
}
```

- [ ] **Step 6: 实现访问控制**

`apps/bff/src/observability/observability-access.ts`：

```ts
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { isLoopback } from '../kb/loopback';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** /metrics 与 /health/ready：仅回环或携带正确内部 token。 */
export function observabilityAllowed(req: FastifyRequest): boolean {
  if (isLoopback(req.ip)) return true;
  const token = process.env.INTERNAL_TOKEN;
  const got = req.headers['x-internal-token'];
  return !!token && typeof got === 'string' && safeEqual(got, token);
}
```

- [ ] **Step 7: 实现请求钩子**

`apps/bff/src/observability/request-telemetry.ts`：

```ts
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
```

> `traceId` 显式写入访问日志：`finish/close` 事件的触发上下文不一定还在请求的 ALS 中，不能依赖 mixin。

- [ ] **Step 8: 实现 Nest 日志适配器**

`apps/bff/src/observability/app-logger.ts`：

```ts
import { Injectable, type LoggerService } from '@nestjs/common';
import { createLogger } from '@ai-office/telemetry';
import type { Logger } from 'pino';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Nest LoggerService → pino；context 作为字段，错误对象统一放 err。 */
@Injectable()
export class AppLogger implements LoggerService {
  readonly raw: Logger;

  constructor() {
    this.raw = createLogger('bff');
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write('info', message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  private write(level: Level, message: unknown, optional: unknown[]): void {
    const last = optional[optional.length - 1];
    const context = typeof last === 'string' ? last : undefined;
    const err =
      message instanceof Error
        ? { type: message.name, message: message.message, stack: message.stack }
        : undefined;
    const msg = message instanceof Error ? message.message : String(message);
    this.raw[level]({ msg, context, err });
  }
}
```

- [ ] **Step 9: 实现 `/metrics` 与健康检查**

`apps/bff/src/observability/metrics.controller.ts`：

```ts
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BFF_METRICS, type BffMetrics } from './observability.metrics';
import { observabilityAllowed } from './observability-access';

@Controller()
export class MetricsController {
  constructor(@Inject(BFF_METRICS) private readonly metrics: BffMetrics) {}

  @Get('metrics')
  async scrape(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!observabilityAllowed(req)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const body = await this.metrics.registry.metrics();
    reply.header('content-type', this.metrics.registry.contentType).send(body);
  }
}
```

`apps/bff/src/observability/health.service.ts`：

```ts
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { HealthCheckDto, HealthReadyDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { BFF_METRICS, type BffMetrics } from './observability.metrics';

const CHECK_TIMEOUT_MS = 2000;

function appVersion(): string {
  return process.env.APP_VERSION ?? '0.0.0';
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), CHECK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private redis?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BFF_METRICS) readonly metrics: BffMetrics,
  ) {}

  async ready(): Promise<HealthReadyDto> {
    const [db, redis, runtime] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkRuntime(),
    ]);
    this.metrics.serviceUp.set({ service: 'db' }, db.ok ? 1 : 0);
    this.metrics.serviceUp.set({ service: 'redis' }, redis.ok ? 1 : 0);
    this.metrics.serviceUp.set({ service: 'runtime' }, runtime.ok ? 1 : 0);
    const status = db.ok && redis.ok && runtime.ok ? 'ready' : 'degraded';
    return { status, version: appVersion(), checks: { db, redis, runtime } };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      this.redis.disconnect();
      this.redis = undefined;
    }
  }

  private async checkDb(): Promise<HealthCheckDto> {
    const started = Date.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, 'db');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private async checkRedis(): Promise<HealthCheckDto> {
    if (!process.env.REDIS_URL) return { ok: true, skipped: true };
    const started = Date.now();
    try {
      const client = this.redisClient();
      await withTimeout(client.ping(), 'redis');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      this.redis?.disconnect();
      this.redis = undefined;
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private async checkRuntime(): Promise<HealthCheckDto> {
    const started = Date.now();
    const base = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const token = process.env.AGENT_RUNTIME_TOKEN;
    try {
      const res = await withTimeout(
        fetch(`${base.replace(/\/+$/, '')}/health`, {
          headers: token ? { 'x-agent-runtime-token': token } : {},
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        }),
        'runtime',
      );
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private redisClient(): Redis {
    if (!this.redis) {
      this.redis = new Redis(process.env.REDIS_URL as string, {
        lazyConnect: true,
        connectTimeout: CHECK_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        commandTimeout: CHECK_TIMEOUT_MS,
      });
      // 健康检查自己汇报错误；这里吞掉 error 事件，避免 ioredis 未处理事件导致进程退出。
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }
}
```

`apps/bff/src/observability/health.controller.ts`：

```ts
import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HealthService } from './health.service';
import { observabilityAllowed } from './observability-access';

@Controller('api/health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  live(): { status: 'ok'; version: string } {
    return { status: 'ok', version: process.env.APP_VERSION ?? '0.0.0' };
  }

  @Get('ready')
  async ready(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!observabilityAllowed(req)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const result = await this.health.ready();
    reply.code(result.status === 'ready' ? 200 : 503).send(result);
  }
}
```

- [ ] **Step 10: 实现模块并接入 AppModule**

`apps/bff/src/observability/observability.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { MetricsController } from './metrics.controller';
import { BFF_METRICS, createBffMetrics } from './observability.metrics';

@Global()
@Module({
  controllers: [MetricsController, HealthController],
  providers: [
    { provide: BFF_METRICS, useFactory: () => createBffMetrics() },
    AppLogger,
    HealthService,
  ],
  exports: [BFF_METRICS, AppLogger, HealthService],
})
export class ObservabilityModule {}
```

`apps/bff/src/app.module.ts` 的 `imports` 数组第一项加入 `ObservabilityModule`，并在 import 区加：

```ts
import { ObservabilityModule } from './observability/observability.module';
```

- [ ] **Step 11: 改 main.ts**

完整替换 `apps/bff/src/main.ts`：

```ts
import 'reflect-metadata';
import { loadRootEnv } from './load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { initTelemetry, shutdownTelemetry } from '@ai-office/telemetry';
import { AppModule } from './app.module';
import { CORS_OPTIONS } from './cors';
import { assertConnectorKey } from './connector/crypto';
import { AppLogger } from './observability/app-logger';
import { BFF_METRICS, type BffMetrics } from './observability/observability.metrics';
import { registerRequestTelemetry } from './observability/request-telemetry';

loadRootEnv();
initTelemetry({
  serviceName: 'bff',
  serviceVersion: process.env.APP_VERSION ?? '0.0.0',
});

async function bootstrap(): Promise<void> {
  assertConnectorKey();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.enableCors(CORS_OPTIONS);

  // 钩子必须在 listen 前注册，确保启动后的每个请求都有 trace/日志/指标。
  registerRequestTelemetry(
    app.getHttpAdapter().getInstance(),
    app.get<BffMetrics>(BFF_METRICS),
    logger.raw,
  );

  const maxBytes = Number(process.env.KB_MAX_FILE_BYTES);
  await app.register(multipart as unknown as Parameters<typeof app.register>[0], {
    limits: { fileSize: Number.isFinite(maxBytes) ? maxBytes : 10485760 },
  });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');

  const close = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    await shutdownTelemetry();
  };
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));

  logger.log(`bff listening on http://localhost:${port}`);
}

bootstrap().catch(async (err: unknown) => {
  console.error('bff 启动失败', err);
  await shutdownTelemetry();
  process.exit(1);
});
```

- [ ] **Step 12: 跑测试、类型检查与构建**

```bash
pnpm --filter @ai-office/bff test -- src/observability
pnpm --filter @ai-office/bff typecheck
pnpm --filter @ai-office/bff build
```

Expected: 新增测试 PASS，typecheck 无输出，build 成功。

- [ ] **Step 13: 提交**

```bash
git add apps/bff/src/observability apps/bff/src/app.module.ts apps/bff/src/main.ts apps/bff/package.json pnpm-lock.yaml
git commit -m "feat(bff): 接入请求追踪、结构化日志与指标端点

BFF 此前只有零散 console 与 Nest 日志，跨进程排障无法按 traceId 串联，
也没有 Prometheus 指标。现在由统一中间件生成/提取 traceparent、输出带请求
字段的 JSON 访问日志，并暴露受内部凭据保护的 /metrics 与健康检查，为后续
run 埋点、快照与告警提供基础。"
```

---

## Task 3: BFF run 埋点、上游 traceparent 与计费指标

**Files:**
- Create: `apps/bff/src/observability/run-telemetry.ts`
- Test: `apps/bff/src/observability/run-telemetry.test.ts`
- Modify: `apps/bff/src/tasks/tasks.controller.ts`
- Modify: `apps/bff/src/auth/jwt.guard.ts`
- Modify: `apps/bff/src/billing/billing.service.ts`
- Modify: `apps/bff/src/billing/billing.sweeper.ts`
- Test: `apps/bff/src/tasks/tasks.controller.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/bff/src/observability/run-telemetry.test.ts`：

```ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ModelPriceDto, RunBilling, UsageEvent } from '@ai-office/shared';
import { createBffMetrics } from './observability.metrics';
import { allocateModelCredits, RunTelemetry } from './run-telemetry';

const price = (input: number, output: number): ModelPriceDto => ({
  inputMilliCreditsPer1k: input,
  outputMilliCreditsPer1k: output,
});

const billing: RunBilling = {
  maxCredits: 100,
  allowedModels: ['a', 'b'],
  prices: { a: price(1000, 1000), b: price(1000, 1000) },
};

const usage: UsageEvent = {
  input: 1000,
  output: 1000,
  models: [
    { model: 'a', input: 1000, output: 0 },
    { model: 'b', input: 0, output: 1000 },
  ],
};

describe('RunTelemetry', () => {
  it('按价格比例分摊积分且总和等于计费总额', () => {
    expect(allocateModelCredits(usage.models, billing.prices, 2)).toEqual([
      { model: 'a', credits: 1 },
      { model: 'b', credits: 1 },
    ]);
  });

  it('cap 为 0 时不产生模型积分', () => {
    expect(allocateModelCredits([{ model: 'a', input: 1, output: 1 }], billing.prices, 0)).toEqual([]);
  });

  it('finish 只执行一次并记录运行状态、token 与积分', async () => {
    const metrics = createBffMetrics({ defaultMetrics: false });
    const telemetry = new RunTelemetry(metrics);
    telemetry.finish('done', usage, billing, 1.5);
    telemetry.finish('failed', null, billing, 9);
    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_active_runs 0');
    expect(text).toContain('ai_office_runs_total{status="done"} 1');
    expect(text).not.toContain('status="failed"');
    expect(text).toContain('ai_office_model_tokens_total{model="a",type="input"} 1000');
    expect(text).toContain('ai_office_model_credits_total{model="a"} 1');
  });

  it('forceFail 让早期失败路径仍标记 failed', async () => {
    const metrics = createBffMetrics({ defaultMetrics: false });
    const telemetry = new RunTelemetry(metrics);
    telemetry.forceFail();
    telemetry.finish('done', null, billing, 0);
    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_runs_total{status="failed"} 1');
  });
});
```

在 `apps/bff/src/tasks/tasks.controller.test.ts` 中做三处修改，并新增一条用例：

1. 顶部 import 增加：

```ts
import { initTelemetry, shutdownTelemetry } from '@ai-office/telemetry';
import { BFF_METRICS } from '../observability/observability.metrics';
import { createBffMetrics } from '../observability/observability.metrics';
```

2. 模块级状态增加：

```ts
// 上游收到的最近一次 traceparent，供断言 BFF 透传 W3C 追踪头。
let lastTraceparent = '';
```

在上游 `createServer` 回调的 `req.on('end', () => {` 内、`lastRunsBody = reqBody;` 之后加：

```ts
      lastTraceparent = String(req.headers.traceparent ?? '');
```

在 `beforeAll` 开头加 `initTelemetry({ serviceName: 'bff-task-test', serviceVersion: '1' });`，在 `afterAll` 末尾加 `await shutdownTelemetry();`。

3. `providers` 数组增加：

```ts
      { provide: BFF_METRICS, useValue: createBffMetrics({ defaultMetrics: false }) },
```

4. `beforeEach` 中增加 `lastTraceparent = '';`。

5. 在 `describe('TasksController')` 末尾新增：

```ts
  it('向上游注入合法 W3C traceparent', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(200);
    // 无上游父 span 时应新建 root span：version=00、32 位 traceId、16 位 spanId、采样位=01。
    expect(lastTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/observability/run-telemetry.test.ts
```

Expected: FAIL，`allocateModelCredits` / `RunTelemetry` 不存在。

- [ ] **Step 3: 实现 run-telemetry.ts**

```ts
import type { ModelPriceDto, RunBilling, UsageEvent } from '@ai-office/shared';
import { computeCredits } from '../billing/credits';
import type { BffMetrics } from './observability.metrics';

export interface ModelCredit {
  model: string;
  credits: number;
}

/** 合并同名模型用量，避免 usage 中出现重复条目时重复计费。 */
function mergeModels(models: UsageEvent['models']): UsageEvent['models'] {
  const acc = new Map<string, { input: number; output: number }>();
  for (const item of models) {
    const prev = acc.get(item.model) ?? { input: 0, output: 0 };
    prev.input += item.input;
    prev.output += item.output;
    acc.set(item.model, prev);
  }
  return [...acc].map(([model, usage]) => ({ model, ...usage }));
}

/**
 * 把整次运行的总积分按各模型折算成本比例分摊；最后一个模型吃掉舍入余数，
 * 保证分模型积分之和严格等于总积分。
 */
export function allocateModelCredits(
  models: UsageEvent['models'],
  prices: Record<string, ModelPriceDto>,
  cap: number,
): ModelCredit[] {
  const merged = mergeModels(models);
  const total = computeCredits(merged, prices, cap);
  if (total === 0 || merged.length === 0) return [];
  const scaled = merged.map((m) => {
    const p = prices[m.model];
    return {
      model: m.model,
      scaled: p ? m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k : 0,
    };
  });
  const sum = scaled.reduce((acc, item) => acc + item.scaled, 0);
  if (sum <= 0) return [{ model: merged[0].model, credits: total }];

  let remaining = total;
  const out: ModelCredit[] = [];
  for (let i = 0; i < scaled.length; i++) {
    const item = scaled[i];
    const credits =
      i === scaled.length - 1
        ? remaining
        : Math.min(remaining, Math.floor((total * item.scaled) / sum));
    remaining -= credits;
    if (credits > 0) out.push({ model: item.model, credits });
  }
  return out;
}

/** run 结束收尾：active gauge、终态计数、时长、token/积分；finish 幂等。 */
export class RunTelemetry {
  private finished = false;
  private forcedFailed = false;

  constructor(private readonly metrics: BffMetrics) {
    metrics.activeRuns.inc();
  }

  forceFail(): void {
    this.forcedFailed = true;
  }

  finish(
    status: 'done' | 'failed',
    usage: UsageEvent | null,
    billing: RunBilling,
    durationSeconds: number,
  ): void {
    if (this.finished) return;
    this.finished = true;
    const finalStatus = this.forcedFailed ? 'failed' : status;
    this.metrics.activeRuns.dec();
    this.metrics.runsTotal.inc({ status: finalStatus });
    this.metrics.runDuration.observe(Math.max(0, durationSeconds));

    if (!usage) return;
    for (const item of mergeModels(usage.models)) {
      this.metrics.modelTokens.inc({ model: item.model, type: 'input' }, item.input);
      this.metrics.modelTokens.inc({ model: item.model, type: 'output' }, item.output);
    }
    for (const item of allocateModelCredits(usage.models, billing.prices, billing.maxCredits)) {
      this.metrics.modelCredits.inc({ model: item.model }, item.credits);
    }
  }
}
```

- [ ] **Step 4: 改 TasksController**

在文件顶部 import 区增加：

```ts
import { endSpan, injectTraceparent, startSpan } from '@ai-office/telemetry';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { RunTelemetry } from '../observability/run-telemetry';
```

并把 `@nestjs/common` 的 import 补上 `Inject`：

```ts
import { Body, Controller, Inject, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
```

构造函数末尾增加指标依赖：

```ts
  constructor(
    private readonly tasks: TasksService,
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}
```

在 `const { taskId, tenantId, userId, messages } = prepared;` 之后、`reply.hijack();` 之前插入：

```ts
    // 运行指标从建好 task/run 之后开始统计；结算失败计数也走同一 BFF 指标注册表。
    const runTelemetry = new RunTelemetry(this.metrics);
    const runStarted = Date.now();
    let status: 'done' | 'failed' = 'done';
    let latestUsage: UsageEvent | null = null;
```

把原来第 239–240 行的 `let status` / `let latestUsage` 两行删除（变量已前移）。

在 `reply.hijack();` 之后立即加 `try {`，并在方法最末尾（`}` 前）补：

```ts
    } finally {
      runTelemetry.finish(
        status,
        latestUsage,
        billing,
        (Date.now() - runStarted) / 1000,
      );
    }
```

这样每个返回路径（含 502、非 2xx、空 body）都会经 finally 收尾，且 `RunTelemetry.finish` 幂等。

把 fetch 段改为：

```ts
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
```

在非 2xx 分支的 `await this.billing.releaseHold(runId)` 之前加 `runTelemetry.forceFail();`；在空 body 分支同样加。

在结算失败的 catch 中增加失败计数：

```ts
          } catch (err) {
            // settle 失败时 hold 与 pending 都还在，由补偿任务重试。
            this.metrics.billingSettleFailures.inc();
            this.logger.error(`run ${runId} 计费结算失败（保留 pending 待补偿）: ${(err as Error).message}`);
          }
```

- [ ] **Step 5: 改 JwtGuard**

在 import 区加入：

```ts
import { addSpanAttributes, updateContext } from '@ai-office/telemetry';
```

在 `req.user = { ... };` 之后加：

```ts
    // 鉴权在 onRequest 之后执行：这里把用户/租户回填进 ALS，后续日志自动带上；
    // span 属性只放稳定 ID，不放邮箱等 PII。
    updateContext({ userId: payload.sub, tenantId: user.tenantId });
    addSpanAttributes({ 'enduser.id': payload.sub, 'tenant.id': user.tenantId });
```

- [ ] **Step 6: 改计费限流与补偿指标**

`apps/bff/src/billing/billing.service.ts`：

- import：

```ts
import { Inject, Optional } from '@nestjs/common';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
```

- 构造函数末尾加：

```ts
@Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
```

- 在 `if (!rl.allowed)` 分支：

```ts
if (!rl.allowed) {
  this.metrics?.rateLimitHits.inc({ scope: 'tenant' });
  throw new RateLimitedError(rl.retryAfter);
}
```

`apps/bff/src/billing/billing.sweeper.ts`：

- 同样注入可选 `BFF_METRICS`。
- 在 `settleStalePending` 与 `sweepOrphanHolds` 的 catch 中加 `this.metrics?.billingSettleFailures.inc();`。

- [ ] **Step 7: 跑测试**

```bash
pnpm --filter @ai-office/bff test -- src/observability/run-telemetry.test.ts src/tasks/tasks.controller.test.ts src/billing
pnpm --filter @ai-office/bff typecheck
```

Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 8: 提交**

```bash
git add apps/bff/src/observability/run-telemetry.ts apps/bff/src/observability/run-telemetry.test.ts apps/bff/src/tasks/tasks.controller.ts apps/bff/src/tasks/tasks.controller.test.ts apps/bff/src/auth/jwt.guard.ts apps/bff/src/billing
git commit -m "feat(bff): 埋点运行与计费并透传上游追踪

一次运行的成功率、耗时、token 与积分此前只散落在数据库和响应流里，
无法在指标侧观察，也无法把 BFF 与 runtime 的日志关联到同一条 trace。
现在 run 结束时统一收尾指标、向 runtime 注入子 span 的 traceparent，
并把鉴权后的用户/租户写入 trace 上下文与限流、结算失败计数。"
```
---

## Task 4: runtime 接入指标、span 与日志

**Files:**
- Modify: `packages/shared/src/dto.ts`
- Modify: `apps/agent-runtime/package.json`
- Create: `apps/agent-runtime/src/observability/metrics.ts`
- Test: `apps/agent-runtime/src/observability/metrics.test.ts`
- Create: `apps/agent-runtime/src/model/observed-gateway.ts`
- Test: `apps/agent-runtime/src/model/observed-gateway.test.ts`
- Modify: `apps/agent-runtime/src/model/routing-gateway.ts`
- Modify: `apps/agent-runtime/src/model/create-gateway.ts`
- Modify: `apps/agent-runtime/src/agent-loop.ts`
- Test: `apps/agent-runtime/src/agent-loop.test.ts`
- Modify: `apps/agent-runtime/src/mcp/host.ts`
- Test: `apps/agent-runtime/src/mcp/host.test.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Test: `apps/agent-runtime/src/server.test.ts`

- [ ] **Step 1: 增加共享 DTO**

在 `packages/shared/src/dto.ts` 末尾追加：

```ts
/** runtime `/metrics/summary`：按分钟窗口聚合的模型/MCP 观测数据。 */
export interface RuntimeModelSummaryDto {
  model: string;
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
}

export interface RuntimeSummaryDto {
  /** 窗口内没有任何模型样本时为 insufficient_data，告警评估需跳过而不是误报。 */
  status: 'ok' | 'insufficient_data';
  windowMinutes: number;
  activeRuns: number;
  models: RuntimeModelSummaryDto[];
  fallbacks: number;
  mcpRestarts: number;
}
```

构建立即生效的声明文件：

```bash
pnpm --filter @ai-office/shared build
```

Expected: `dist/index.d.ts` 中出现 `RuntimeSummaryDto`。

- [ ] **Step 2: 补依赖**

`apps/agent-runtime/package.json` 的 `dependencies` 增加：

```json
    "@ai-office/telemetry": "workspace:*",
    "pino": "^10.4.0",
    "prom-client": "^15.1.3",
```

执行：

```bash
pnpm install
pnpm --filter @ai-office/telemetry build
```

Expected: lockfile 更新；telemetry `dist/` 已生成（Task 1/2 已构建过，这里是幂等确认）。

- [ ] **Step 3: 写失败的 runtime 指标测试**

`apps/agent-runtime/src/observability/metrics.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createRuntimeMetrics } from './metrics';

describe('createRuntimeMetrics', () => {
  it('按分钟窗口汇总模型请求、错误、平均延迟与 fallback/MCP 重启', () => {
    let now = Date.UTC(2026, 9, 20, 10, 0, 0);
    const metrics = createRuntimeMetrics({ defaultMetrics: false, now: () => now });
    metrics.recordModelAttempt('a', 'ok', 100);
    metrics.recordModelAttempt('a', 'error', 300);
    metrics.recordModelAttempt('b', 'ok', 200);
    metrics.recordModelFallback('a', 'b');
    metrics.recordMcpRestart('srv');

    const summary = metrics.summary(15);
    expect(summary.status).toBe('ok');
    expect(summary.windowMinutes).toBe(15);
    expect(summary.models).toEqual([
      { model: 'a', requests: 2, errors: 1, avgLatencyMs: 200 },
      { model: 'b', requests: 1, errors: 0, avgLatencyMs: 200 },
    ]);
    expect(summary.fallbacks).toBe(1);
    expect(summary.mcpRestarts).toBe(1);
  });

  it('窗口外样本不计入，窗口夹取到 1–60 分钟，空样本返回 insufficient_data', () => {
    let now = Date.UTC(2026, 9, 20, 10, 0, 0);
    const metrics = createRuntimeMetrics({ defaultMetrics: false, now: () => now });
    metrics.recordModelAttempt('a', 'ok', 100);

    now += 3 * 60_000;
    const narrow = metrics.summary(1);
    expect(narrow.models).toEqual([]);
    expect(narrow.status).toBe('insufficient_data');
    expect(metrics.summary(0).windowMinutes).toBe(1);
    expect(metrics.summary(999).windowMinutes).toBe(60);
    expect(metrics.summary(Number.NaN).windowMinutes).toBe(15);
  });

  it('活跃 run 计数归零且不出现负数', async () => {
    const metrics = createRuntimeMetrics({ defaultMetrics: false });
    metrics.runStarted();
    metrics.runStarted();
    expect(metrics.summary(15).activeRuns).toBe(2);
    metrics.runFinished();
    metrics.runFinished();
    metrics.runFinished();
    expect(metrics.summary(15).activeRuns).toBe(0);
    expect(await metrics.registry.metrics()).toContain('ai_office_active_runs 0');
  });

  it('工具、MCP 与代码执行超时进入指标，模型 label 截断到 64', async () => {
    const metrics = createRuntimeMetrics({ defaultMetrics: false });
    metrics.recordToolCall('web.search', 'ok', 12);
    metrics.recordMcpToolCall('srv', 'echo', 'ok');
    metrics.recordCodeExecTimeout();
    metrics.recordModelAttempt('m'.repeat(100), 'ok', 1);
    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_tool_calls_total{tool="web.search",status="ok"} 1');
    expect(text).toContain('ai_office_mcp_tool_calls_total{server="srv",tool="echo",status="ok"} 1');
    expect(text).toContain('ai_office_code_exec_timeout_total 1');
    expect(text).not.toContain('m'.repeat(65));
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/observability/metrics.test.ts
```

Expected: FAIL，`./metrics` 不存在。

- [ ] **Step 5: 实现 runtime 指标**

`apps/agent-runtime/src/observability/metrics.ts`：

```ts
import { Counter, Gauge, Histogram } from 'prom-client';
import {
  boundedLabel,
  createMetricsRegistry,
  MODEL_DURATION_BUCKETS,
  TOOL_DURATION_BUCKETS,
} from '@ai-office/telemetry';
import type { RuntimeSummaryDto } from '@ai-office/shared';

export interface RuntimeMetricsOptions {
  /** 测试关闭进程默认指标，避免为每个测试 server 启动采集定时器。 */
  defaultMetrics?: boolean;
  /** 可注入时钟，供窗口测试使用。 */
  now?: () => number;
}

interface ModelSample {
  requests: number;
  errors: number;
  durationMs: number;
}

interface MinuteBucket {
  minute: number;
  models: Map<string, ModelSample>;
  fallbacks: number;
  mcpRestarts: number;
}

const MAX_WINDOW_MINUTES = 60;
const DEFAULT_WINDOW_MINUTES = 15;

export function createRuntimeMetrics(opts: RuntimeMetricsOptions = {}) {
  const registry = createMetricsRegistry({
    defaultMetrics: opts.defaultMetrics ?? process.env.NODE_ENV !== 'test',
  });
  const now = opts.now ?? Date.now;

  const modelRequests = new Counter({
    name: 'ai_office_model_requests_total',
    help: '模型调用尝试次数',
    labelNames: ['model', 'status'] as const,
    registers: [registry],
  });
  const modelDuration = new Histogram({
    name: 'ai_office_model_request_duration_seconds',
    help: '模型调用尝试耗时',
    labelNames: ['model'] as const,
    buckets: MODEL_DURATION_BUCKETS,
    registers: [registry],
  });
  const modelFallback = new Counter({
    name: 'ai_office_model_fallback_total',
    help: '模型 fallback 次数',
    labelNames: ['from', 'to'] as const,
    registers: [registry],
  });
  const toolCalls = new Counter({
    name: 'ai_office_tool_calls_total',
    help: '工具调用次数',
    labelNames: ['tool', 'status'] as const,
    registers: [registry],
  });
  const toolDuration = new Histogram({
    name: 'ai_office_tool_duration_seconds',
    help: '工具执行耗时',
    labelNames: ['tool'] as const,
    buckets: TOOL_DURATION_BUCKETS,
    registers: [registry],
  });
  const mcpRestarts = new Counter({
    name: 'ai_office_mcp_restarts_total',
    help: 'MCP 子进程恢复次数',
    labelNames: ['server'] as const,
    registers: [registry],
  });
  const mcpToolCalls = new Counter({
    name: 'ai_office_mcp_tool_calls_total',
    help: 'MCP 工具调用次数',
    labelNames: ['server', 'tool', 'status'] as const,
    registers: [registry],
  });
  const codeExecTimeouts = new Counter({
    name: 'ai_office_code_exec_timeout_total',
    help: 'code.exec 超时次数',
    registers: [registry],
  });
  const activeRunsGauge = new Gauge({
    name: 'ai_office_active_runs',
    help: '当前活跃 run 数',
    registers: [registry],
  });

  let activeRuns = 0;
  // 只保留最近 60 个分钟桶：进程重启后从零开始，不持久化。
  const buckets: MinuteBucket[] = [];

  const bucketFor = (minute: number): MinuteBucket => {
    const last = buckets[buckets.length - 1];
    if (last && last.minute === minute) return last;
    // 分钟单调递增；时钟回拨时沿用最后一个桶，避免乱序与窗口错乱。
    if (last && minute < last.minute) return last;
    const bucket: MinuteBucket = { minute, models: new Map(), fallbacks: 0, mcpRestarts: 0 };
    buckets.push(bucket);
    while (buckets.length > MAX_WINDOW_MINUTES) buckets.shift();
    return bucket;
  };

  const currentBucket = (): MinuteBucket => bucketFor(Math.floor(now() / 60_000));

  return {
    registry,

    recordModelAttempt(model: string, status: 'ok' | 'error', durationMs: number): void {
      const label = boundedLabel(model, 64);
      modelRequests.inc({ model: label, status });
      modelDuration.observe({ model: label }, durationMs / 1000);
      const bucket = currentBucket();
      const sample = bucket.models.get(label) ?? { requests: 0, errors: 0, durationMs: 0 };
      sample.requests += 1;
      if (status === 'error') sample.errors += 1;
      sample.durationMs += durationMs;
      bucket.models.set(label, sample);
    },

    recordModelFallback(from: string, to: string): void {
      modelFallback.inc({ from: boundedLabel(from, 64), to: boundedLabel(to, 64) });
      currentBucket().fallbacks += 1;
    },

    recordToolCall(tool: string, status: string, durationMs: number): void {
      const label = boundedLabel(tool, 64);
      toolCalls.inc({ tool: label, status });
      toolDuration.observe({ tool: label }, durationMs / 1000);
    },

    recordMcpToolCall(server: string, tool: string, status: string): void {
      mcpToolCalls.inc({
        server: boundedLabel(server, 64),
        tool: boundedLabel(tool, 64),
        status,
      });
    },

    recordMcpRestart(server: string): void {
      mcpRestarts.inc({ server: boundedLabel(server, 64) });
      currentBucket().mcpRestarts += 1;
    },

    recordCodeExecTimeout(): void {
      codeExecTimeouts.inc();
    },

    runStarted(): void {
      activeRuns += 1;
      activeRunsGauge.set(activeRuns);
    },

    runFinished(): void {
      activeRuns = Math.max(0, activeRuns - 1);
      activeRunsGauge.set(activeRuns);
    },

    /** 供告警评估使用；窗口越界夹取到 1–60 分钟，非有限值回落到 15。 */
    summary(windowMinutes = DEFAULT_WINDOW_MINUTES): RuntimeSummaryDto {
      const window = Number.isFinite(windowMinutes)
        ? Math.min(MAX_WINDOW_MINUTES, Math.max(1, Math.floor(windowMinutes)))
        : DEFAULT_WINDOW_MINUTES;
      const current = Math.floor(now() / 60_000);
      const from = current - window + 1;
      const models = new Map<string, ModelSample>();
      let fallbacks = 0;
      let restarts = 0;
      for (const bucket of buckets) {
        if (bucket.minute < from || bucket.minute > current) continue;
        fallbacks += bucket.fallbacks;
        restarts += bucket.mcpRestarts;
        for (const [model, sample] of bucket.models) {
          const agg = models.get(model) ?? { requests: 0, errors: 0, durationMs: 0 };
          agg.requests += sample.requests;
          agg.errors += sample.errors;
          agg.durationMs += sample.durationMs;
          models.set(model, agg);
        }
      }
      const list = [...models].map(([model, sample]) => ({
        model,
        requests: sample.requests,
        errors: sample.errors,
        avgLatencyMs: sample.requests > 0 ? Math.round(sample.durationMs / sample.requests) : null,
      }));
      return {
        status: list.some((m) => m.requests > 0) ? 'ok' : 'insufficient_data',
        windowMinutes: window,
        activeRuns,
        models: list,
        fallbacks,
        mcpRestarts: restarts,
      };
    },
  };
}

export type RuntimeMetrics = ReturnType<typeof createRuntimeMetrics>;
```

- [ ] **Step 6: 跑指标测试**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/observability/metrics.test.ts
```

Expected: PASS（4 个用例）。

- [ ] **Step 7: 写失败的模型观察者测试**

`apps/agent-runtime/src/model/observed-gateway.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createGateway } from './create-gateway';
import { ObservedGateway } from './observed-gateway';
import { RoutingGateway } from './routing-gateway';
import { ModelHttpError } from './errors';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

function ok(model: string): ChatResponse {
  return { content: model, toolCalls: [], usage: { input: 1, output: 1 }, model };
}

describe('model observer', () => {
  it('RoutingGateway 逐次记录尝试，可重试失败后记录 fallback', async () => {
    const events: string[] = [];
    const observer = {
      onAttempt: (model: string, okResult: boolean) => events.push(`${model}:${okResult}`),
      onFallback: (from: string, to: string) => events.push(`fallback:${from}->${to}`),
    };
    const gateway = new RoutingGateway(
      [
        {
          model: 'a',
          gateway: {
            async chat() {
              throw new ModelHttpError(500, 'a');
            },
          },
        },
        { model: 'b', gateway: { async chat() { return ok('b'); } } },
      ],
      observer,
    );
    const res = await gateway.chat(req);
    expect(res.model).toBe('b');
    expect(events).toEqual(['a:false', 'fallback:a->b', 'b:true']);
  });

  it('不可重试错误不记录 fallback', async () => {
    const events: string[] = [];
    const gateway = new RoutingGateway(
      [
        {
          model: 'a',
          gateway: {
            async chat() {
              throw new ModelHttpError(400, 'a');
            },
          },
        },
        { model: 'b', gateway: { async chat() { return ok('b'); } } },
      ],
      {
        onAttempt: (model, okResult) => events.push(`${model}:${okResult}`),
        onFallback: (from, to) => events.push(`fallback:${from}->${to}`),
      },
    );
    await expect(gateway.chat(req)).rejects.toBeInstanceOf(ModelHttpError);
    expect(events).toEqual(['a:false']);
  });

  it('ObservedGateway 为单模型网关补埋点并透传结果', async () => {
    const events: string[] = [];
    let clock = 1000;
    const inner: ModelGateway = {
      async chat() {
        clock += 120;
        return ok('x');
      },
    };
    const gateway = new ObservedGateway(
      inner,
      'x',
      {
        onAttempt: (model, okResult, durationMs) =>
          events.push(`${model}:${okResult}:${durationMs}`),
        onFallback: () => undefined,
      },
      () => clock,
    );
    const res = await gateway.chat(req);
    expect(res.model).toBe('x');
    expect(events).toEqual(['x:true:120']);
  });

  it('createGateway 不传 observer 时保持原有实例类型', () => {
    expect(createGateway({}).constructor.name).toBe('MockGateway');
  });

  it('createGateway 传 observer 时包装单模型网关', () => {
    const gateway = createGateway({}, {
      onAttempt: () => undefined,
      onFallback: () => undefined,
    });
    expect(gateway).toBeInstanceOf(ObservedGateway);
  });
});
```

- [ ] **Step 8: 运行测试确认失败**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/model/observed-gateway.test.ts
```

Expected: FAIL，`./observed-gateway` 不存在。

- [ ] **Step 9: 实现观察者并接入路由网关**

`apps/agent-runtime/src/model/observed-gateway.ts`：

```ts
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

/** 模型调用观测钩子；实现方不应抛错，否则会污染业务调用链。 */
export interface ModelObserver {
  onAttempt(model: string, ok: boolean, durationMs: number): void;
  onFallback(from: string, to: string): void;
}

/**
 * 给没有路由层的单模型网关补埋点：RoutingGateway 在每次尝试内部埋点，
 * 单模型网关没有这层循环，必须在外部包一层才能拿到成功/失败与耗时。
 */
export class ObservedGateway implements ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly model: string,
    private readonly observer: ModelObserver,
    private readonly now: () => number = Date.now,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = this.now();
    try {
      const res = await this.inner.chat(req);
      this.observer.onAttempt(this.model, true, this.now() - started);
      return res;
    } catch (err) {
      this.observer.onAttempt(this.model, false, this.now() - started);
      throw err;
    }
  }
}
```

`apps/agent-runtime/src/model/routing-gateway.ts` 改为：

```ts
import { endSpan, startSpan } from '@ai-office/telemetry';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';
import type { ModelObserver } from './observed-gateway';
import { ModelHttpError } from './errors';

export interface ModelRoute {
  model: string;
  gateway: ModelGateway;
}

/** 仅网络错误、429、5xx 值得换模型；其余 4xx 多半是参数/鉴权问题，重试只会放大错误。 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ModelHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError;
}

/**
 * 多模型路由：按 req.models 的顺序选择已注册的模型；可重试错误切下一个。
 * 不读写账本——预算与结算都留在 BFF。
 */
export class RoutingGateway implements ModelGateway {
  constructor(
    private readonly routes: ModelRoute[],
    private readonly observer?: ModelObserver,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const allowed = req.models;
    let candidates = this.routes.filter((r) => !allowed || allowed.includes(r.model));
    if (allowed) {
      const order = new Map(allowed.map((m, i) => [m, i]));
      candidates = [...candidates].sort(
        (a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0),
      );
    }
    if (candidates.length === 0) throw new Error('model_not_allowed');

    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const route = candidates[i];
      const started = Date.now();
      // 每次尝试单独成 span：失败重试在 trace 里可见，而不是只看到最终成功那一次。
      const span = startSpan('model.chat', { 'gen_ai.request.model': route.model });
      try {
        const res = await route.gateway.chat(req);
        endSpan(span, true);
        this.observer?.onAttempt(route.model, true, Date.now() - started);
        return res;
      } catch (err) {
        endSpan(span, false, err);
        this.observer?.onAttempt(route.model, false, Date.now() - started);
        lastErr = err;
        if (!isRetryable(err)) throw err;
        const next = candidates[i + 1];
        if (next) this.observer?.onFallback(route.model, next.model);
      }
    }
    throw lastErr;
  }
}
```

`apps/agent-runtime/src/model/create-gateway.ts` 的 import 与 `createGateway` 改为：

```ts
import type { ModelGateway } from './types';
import type { ModelObserver } from './observed-gateway';
import { ObservedGateway } from './observed-gateway';
import { OpenAICompatGateway } from './openai-compat';
import { MockGateway } from './mock-gateway';
import { RoutingGateway } from './routing-gateway';
```

```ts
/**
 * 配置了 MODEL_PROVIDERS 且至少一个 provider 有 key → 多模型路由；
 * 否则沿用单模型配置；完全没有 key → MockGateway（本地/CI）。
 * 传 observer 时单模型网关外包一层观测；不传则保持原实例，兼容既有调用方。
 */
export function createGateway(
  env: NodeJS.ProcessEnv = process.env,
  observer?: ModelObserver,
): ModelGateway {
  const providers = parseProviders(env.MODEL_PROVIDERS).filter((p) => env[p.apiKeyEnv]);
  if (providers.length > 0) {
    return new RoutingGateway(
      providers.map((p) => ({
        model: p.model,
        gateway: new OpenAICompatGateway({
          baseUrl: p.baseUrl,
          apiKey: env[p.apiKeyEnv] as string,
          model: p.model,
        }),
      })),
      observer,
    );
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const mock = new MockGateway();
    return observer ? new ObservedGateway(mock, 'mock', observer) : mock;
  }
  const model = env.MODEL_NAME ?? 'deepseek-chat';
  const inner = new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model,
  });
  return observer ? new ObservedGateway(inner, model, observer) : inner;
}
```

- [ ] **Step 10: 跑模型观察者测试**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/model/observed-gateway.test.ts src/model/routing-gateway.test.ts src/model/create-gateway.test.ts
```

Expected: 全部 PASS；既有测试不传 observer，实例类型断言不受影响。

- [ ] **Step 11: 写失败的工具观测测试**

在 `apps/agent-runtime/src/agent-loop.test.ts` 顶部 import 改为：

```ts
import { describe, it, expect } from 'vitest';
import { runAgent, type ToolObservation } from './agent-loop';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';
import type { ConfirmGate } from './confirm/broker';
import type { AgentEvent, RunRequest, UsageEvent } from '@ai-office/shared';
```

在 `describe('runAgent', () => {` 内追加：

```ts
  it('工具结果映射为 ok/error/blocked 观测，code.exec 超时单独标记', async () => {
    const failed: ToolObservation[] = [];
    const timeoutTool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return { ok: false, timeout: true, stdout: '', stderr: '', durationMs: 5 };
      },
    };
    await collect(
      runAgent(req, {
        gateway: oneShotGateway({ id: 'c1', name: 'code.exec', args: {} }),
        tools: [timeoutTool],
        onToolCall: (o) => failed.push(o),
      }),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      tool: 'code.exec',
      status: 'error',
      codeExecTimeout: true,
    });

    const blocked: ToolObservation[] = [];
    const blockedTool: Tool = {
      name: 'danger',
      description: 'd',
      parameters: {},
      permission: 'blocked',
      async execute() {
        return {};
      },
    };
    await collect(
      runAgent(req, {
        gateway: oneShotGateway({ id: 'c2', name: 'danger', args: {} }),
        tools: [blockedTool],
        onToolCall: (o) => blocked.push(o),
      }),
    );
    expect(blocked[0]).toMatchObject({ tool: 'danger', status: 'blocked', codeExecTimeout: false });
  });

  it('被拒绝的 confirm 工具记为 denied', async () => {
    const seen: ToolObservation[] = [];
    const tool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        return { stdout: 'never' };
      },
    };
    await collect(
      runAgent(req, {
        gateway: oneShotGateway({ id: 'c1', name: 'code.exec', args: {} }),
        tools: [tool],
        confirm: stubGate(false),
        onToolCall: (o) => seen.push(o),
      }),
    );
    expect(seen[0]).toMatchObject({ status: 'denied', codeExecTimeout: false });
  });
```

- [ ] **Step 12: 运行测试确认失败**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/agent-loop.test.ts
```

Expected: FAIL，`ToolObservation` 未导出或 `onToolCall` 不生效。

- [ ] **Step 13: 实现工具观测**

`apps/agent-runtime/src/agent-loop.ts`：

顶部 import 增加：

```ts
import { endSpan, startSpan } from '@ai-office/telemetry';
```

在 `RunDeps` 前新增：

```ts
export interface ToolObservation {
  tool: string;
  status: 'ok' | 'error' | 'denied' | 'blocked';
  durationMs: number;
  /** 仅 code.exec 且子进程因超时被杀时置 true。 */
  codeExecTimeout: boolean;
}
```

`RunDeps` 增加字段：

```ts
  /** 工具埋点；实现方不应抛错。 */
  onToolCall?: (obs: ToolObservation) => void;
```

把工具执行段（`const tool = deps.tools.find(...)` 到 `yield step('tool_result', ...)` 之前）替换为：

```ts
        const tool = deps.tools.find((t) => t.name === call.name);
        let ok = true;
        let status: ToolObservation['status'] = 'ok';
        let result: unknown;
        const extra: Record<string, unknown> = {};
        const toolStarted = Date.now();
        const toolSpan = startSpan('tool.execute', {
          'gen_ai.tool.name': call.name,
          'run.id': req.runId,
        });
        try {
          if (!tool) throw new Error(`unknown_tool:${call.name}`);
          if (tool.permission === 'blocked') {
            ok = false;
            status = 'blocked';
            extra.blocked = true;
            result = { error: 'blocked' };
          } else if (tool.permission === 'confirm') {
            const confirmId = randomUUID();
            // 不变式：confirm_request 必须在 await 之前 yield，否则卡片无法下发、BFF 无从落库。
            yield step('confirm_request', { confirmId, tool: call.name, args: call.args });
            const decision = deps.confirm
              ? await deps.confirm.request(
                  req.runId,
                  confirmId,
                  deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
                )
              : { approved: false, reason: 'user_denied' as const };
            if (decision.approved) {
              extra.approved = true;
              result = await tool.execute(call.args, ctx);
            } else {
              ok = false;
              status = 'denied';
              extra.denied = true;
              extra.reason = decision.reason ?? 'user_denied';
              result = { denied: true, reason: extra.reason };
            }
          } else {
            result = await tool.execute(call.args, ctx);
          }
        } catch (err) {
          ok = false;
          status = 'error';
          result = { error: String(err) };
        }
        // 工具返回 {ok:false}（如 MCP 调用失败）即使没有抛错也算失败；
        // 不改 tool_result.ok 的既有语义（它表示“是否抛错/被拒”），只影响埋点。
        if (status === 'ok' && isFailureResult(result)) status = 'error';
        const durationMs = Date.now() - toolStarted;
        endSpan(toolSpan, status === 'ok');
        deps.onToolCall?.({
          tool: call.name,
          status,
          durationMs,
          codeExecTimeout: call.name === 'code.exec' && isTimeoutResult(result),
        });
```

在文件末尾的辅助函数区追加：

```ts
function isFailureResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
}

function isTimeoutResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { timeout?: unknown }).timeout === true;
}
```

- [ ] **Step 14: 跑工具观测测试**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/agent-loop.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 15: 写失败的 MCP 重启测试**

在 `apps/agent-runtime/src/mcp/host.test.ts` 末尾追加（放在 `describe('McpHost')` 内）：

```ts
  it('进入 error 后重新拉起的成功连接回调 onRestart，首次建连不计重启', async () => {
    vi.useFakeTimers();
    const behavior = { connectFails: true };
    const restarted: string[] = [];
    const made: FakeTransport[] = [];
    const host = new McpHost({
      heartbeatMs: 1000,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      initTimeoutMs: 5000,
      callTimeoutMs: 5000,
      transportFactory: () => {
        const transport = new FakeTransport(behavior);
        made.push(transport);
        return transport;
      },
      onRestart: (server) => restarted.push(server),
    });

    await expect(host.ensure('t1', cfg)).rejects.toThrow('spawn_failed');
    expect(restarted).toEqual([]);

    behavior.connectFails = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(restarted).toEqual(['echo']);
    await host.closeAll();
  });
```

- [ ] **Step 16: 运行测试确认失败**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/mcp/host.test.ts
```

Expected: FAIL，`onRestart` 不在 `McpHostOptions` 上。

- [ ] **Step 17: 实现 MCP 重启回调**

`apps/agent-runtime/src/mcp/host.ts`：

- `McpHostOptions` 增加：

```ts
  /** 从 error 态恢复成功时回调；首次建连不算重启。 */
  onRestart?: (server: string) => void;
```

- `Entry` 增加字段：

```ts
  /** 本次 spawn 是否来自 error 态重拉。 */
  restartedFromError: boolean;
```

- `ensure` 中在 `const prevBackoff = ...` 之前加：

```ts
    const restartedFromError = existing?.state === 'error';
```

- `ensure` 里创建 entry 时带上该字段：

```ts
    const entry: Entry = {
      cfg,
      tenantId,
      transport,
      state: 'starting',
      tools: [],
      backoffMs: prevBackoff,
      restartedFromError,
    };
```

- `spawn` 成功分支（`entry.backoffMs = this.opts.backoffBaseMs;` 之后）加：

```ts
      if (entry.restartedFromError) {
        entry.restartedFromError = false;
        this.opts.onRestart?.(entry.cfg.name);
      }
```

- [ ] **Step 18: 跑 MCP 测试**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/mcp/host.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 19: 写失败的 server 观测测试**

`apps/agent-runtime/src/server.test.ts` 顶部改为：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import type { Server } from 'node:http';
import {
  currentContext,
  currentTrace,
  initTelemetry,
  shutdownTelemetry,
} from '@ai-office/telemetry';
import { decodeSseFrames, createSseParser } from '@ai-office/shared';
import type { AgentEvent, RuntimeSummaryDto } from '@ai-office/shared';
import { createRuntimeServer, isLoopback } from './server';
import { createRuntimeMetrics } from './observability/metrics';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';

// 测试不校验日志输出；保持 stdout 干净。
process.env.LOG_LEVEL = 'silent';
```

在 `beforeAll` 开头加：

```ts
  initTelemetry({ serviceName: 'agent-runtime-test', serviceVersion: '1' });
```

在 `afterAll` 末尾加：

```ts
  await shutdownTelemetry();
```

在 `describe('runtime server')` 内追加：

```ts
  it('GET /metrics 输出 Prometheus 文本，GET /metrics/summary 夹取窗口', async () => {
    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('ai_office_active_runs');

    const summary = await fetch(`${baseUrl}/metrics/summary?windowMinutes=999`);
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as RuntimeSummaryDto;
    expect(body.windowMinutes).toBe(60);
    // 注入的 scripted 网关不经过 createGateway 观察者，窗口内没有模型样本。
    expect(body.status).toBe('insufficient_data');
    expect(body.activeRuns).toBe(0);
  });

  it('设置 AGENT_RUNTIME_TOKEN 后指标端点缺 token 返回 401', async () => {
    process.env.AGENT_RUNTIME_TOKEN = 'secret-tok';
    try {
      expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/metrics/summary`)).status).toBe(401);
      const allowed = await fetch(`${baseUrl}/metrics`, {
        headers: { 'x-agent-runtime-token': 'secret-tok' },
      });
      expect(allowed.status).toBe(200);
      await allowed.text();
    } finally {
      delete process.env.AGENT_RUNTIME_TOKEN;
    }
  });

  it('从 traceparent 续接 traceId，并把工具调用计入指标', async () => {
    const metrics = createRuntimeMetrics({ defaultMetrics: false });
    let seen: { traceId?: string; runId?: string } = {};
    let round = 0;
    const capture: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          seen = { traceId: currentTrace()?.traceId, runId: currentContext().runId };
          return {
            content: '搜索',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 1, output: 1 },
            model: 'mock',
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
      },
    };
    const srv = createRuntimeServer({ gateway: capture, tools: [echo], metrics });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: `00-${traceId}-b7ad6b7169203331-01`,
        },
        body: JSON.stringify({
          runId: 'r-trace',
          sessionId: 's1',
          tenantId: 't1',
          userId: 'u1',
          goal: 'g',
          messages: [{ role: 'user', content: 'g' }],
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(seen).toEqual({ traceId, runId: 'r-trace' });
      const text = await metrics.registry.metrics();
      expect(text).toContain('ai_office_tool_calls_total{tool="web.search",status="ok"} 1');
      expect(text).toContain('ai_office_active_runs 0');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
```

- [ ] **Step 20: 运行测试确认失败**

```bash
pnpm --filter @ai-office/agent-runtime test -- src/server.test.ts
```

Expected: FAIL，`/metrics` 返回 404。

- [ ] **Step 21: 实现 server 观测**

`apps/agent-runtime/src/server.ts`：

顶部 import 增加：

```ts
import { context, SpanKind, trace } from '@opentelemetry/api';
import type { Logger } from 'pino';
import {
  createLogger,
  endSpan,
  extractTraceContext,
  initTelemetry,
  runWithContext,
  shutdownTelemetry,
  startSpan,
} from '@ai-office/telemetry';
import { createRuntimeMetrics, type RuntimeMetrics } from './observability/metrics';
import type { ModelObserver } from './model/observed-gateway';
import type { ToolObservation } from './agent-loop';
```

`RuntimeDeps` 增加：

```ts
  /** 测试注入指标；默认新建独立 Registry。 */
  metrics?: RuntimeMetrics;
  /** 测试注入日志；默认 pino。 */
  logger?: Logger;
```

`createRuntimeServer` 开头改为：

```ts
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
```

`McpHost` 构造参数增加：

```ts
          onRestart: (server) => metrics.recordMcpRestart(server),
```

在 `/health` 分支之后新增两个端点：

```ts
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
```

把 `/runs` 分支里 `res.writeHead(200, {...});` 到该分支结束的异步执行段整体替换为：

```ts
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

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
        // SSE 断开即视为运行结束：同步收尾 span 与活跃计数，避免长连接泄漏。
        const finalizeRun = (ok: boolean, err?: unknown): void => {
          if (finalized) return;
          finalized = true;
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

        // 客户端断开：把该 run 的挂起闸门按拒绝兑现，避免悬停到超时。
        res.on('close', () => {
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
                  const runTools = extraTools
                    ? [...baseTools, ...(await extraTools(runReq.tenantId))]
                    : baseTools;
                  const config = resolveRunConfig(runReq.config, process.env);
                  for await (const ev of runAgent(runReq, {
                    gateway,
                    tools: runTools,
                    confirm,
                    maxRounds: config.maxRounds,
                    confirmTimeoutMs: config.confirmTimeoutMs,
                    codeExecTimeoutMs: config.codeExecTimeoutMs,
                    billing: runReq.billing,
                    onToolCall: (obs) => recordToolObservation(metrics, logger, obs),
                    onUsage: (u) => res.write(encodeSse({ event: 'usage', data: u })),
                  })) {
                    res.write(encodeSse({ event: 'step', data: ev }));
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
                  res.end();
                }
              })();
            },
          ),
        );
```

在 `isLoopback` 之前新增辅助函数：

```ts
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
```

入口段（`if (isEntry) {`）改为：

```ts
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
```

- [ ] **Step 22: 跑 runtime 全部测试与类型检查**

```bash
pnpm --filter @ai-office/agent-runtime test
pnpm --filter @ai-office/agent-runtime typecheck
```

Expected: 全部 PASS；typecheck 无输出。

- [ ] **Step 23: 提交**

```bash
git add packages/shared/src/dto.ts apps/agent-runtime
git commit -m "feat(runtime): 接入运行、模型与工具指标

runtime 此前只有零散 console.warn，BFF 无法判断上游模型失败率、
fallback 频率与 MCP 重启情况，管理端告警也就没有数据来源。
现在 /runs 续接 BFF 的 run span 与日志上下文，每次模型尝试与工具执行
单独成 span 并计数，新增受保护的 /metrics 与按分钟窗口聚合的 /metrics/summary。"
```

---

## Task 5: web 生成并注入 traceparent / x-request-id

**Files:**
- Create: `apps/web/src/lib/trace.ts`
- Test: `apps/web/src/lib/trace.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/api.test.ts`

- [ ] **Step 1: 写失败的 trace 工具测试**

`apps/web/src/lib/trace.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { newRequestId, newTraceparent } from './trace';

describe('trace headers', () => {
  it('生成合法且非零的 W3C traceparent', () => {
    const value = newTraceparent();
    expect(value).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [, traceId, spanId] = value.split('-');
    expect(traceId).not.toMatch(/^0+$/);
    expect(spanId).not.toMatch(/^0+$/);
    expect(newTraceparent()).not.toBe(value);
  });

  it('请求 ID 满足 BFF 的 [A-Za-z0-9-]{1,64} 约束', () => {
    expect(newRequestId()).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @ai-office/web test -- src/lib/trace.test.ts
```

Expected: FAIL，`./trace` 不存在。

- [ ] **Step 3: 实现 trace 工具**

`apps/web/src/lib/trace.ts`：

```ts
/**
 * 浏览器侧的追踪头：每次请求新建一条 trace，BFF 提取后继续派生 span。
 * 仅用于日志/追踪关联，不承载鉴权语义。
 */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    // 极老浏览器兜底：非加密随机，足够做关联 ID。
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** W3C 要求 traceId/spanId 非全零；随机碰撞概率极低，仍显式兜底。 */
function nonZeroHex(bytes: number): string {
  const value = randomHex(bytes);
  return /^0+$/.test(value) ? `1${value.slice(1)}` : value;
}

/** 版本 00、采样位 01：默认全采样，生产采样率由服务端 ParentBasedSampler 决定。 */
export function newTraceparent(): string {
  return `00-${nonZeroHex(16)}-${nonZeroHex(8)}-01`;
}

/** UUID（36 字符）或 32 位十六进制兜底；二者都落在 BFF 的长度与字符集约束内。 */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return randomHex(16);
}
```

- [ ] **Step 4: 跑 trace 测试**

```bash
pnpm --filter @ai-office/web test -- src/lib/trace.test.ts
```

Expected: PASS。

- [ ] **Step 5: 写失败的请求头注入测试**

`apps/web/src/lib/api.test.ts` 的 `confirmRun` 用例，在解析 body 之后追加：

```ts
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{1,64}$/);
```

`uploadKbDoc` 用例末尾追加：

```ts
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{1,64}$/);
```

在文件末尾新增：

```ts
describe('login 追踪头', () => {
  it('login 注入 traceparent 与 x-request-id', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'tok',
            user: { id: 'u1', email: 'a@b.c', role: 'user' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });

    const { login } = await import('./api');
    await login('a@b.c', 'pw');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

```bash
pnpm --filter @ai-office/web test -- src/lib/api.test.ts
```

Expected: FAIL，headers 中缺少 `traceparent`。

- [ ] **Step 7: 在 api.ts 注入请求头**

`apps/web/src/lib/api.ts` 顶部 import 增加：

```ts
import { newRequestId, newTraceparent } from './trace';
```

`authFetch` 的 headers 改为：

```ts
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // 每次调用新建 trace：BFF 会把它作为父上下文继续派生。
      traceparent: newTraceparent(),
      'x-request-id': newRequestId(),
      ...(init.headers ?? {}),
    },
```

`register` 与 `login` 的 headers 改为：

```ts
    headers: {
      'content-type': 'application/json',
      traceparent: newTraceparent(),
      'x-request-id': newRequestId(),
    },
```

`uploadKbDoc` 改为：

```ts
export async function uploadKbDoc(file: File): Promise<KbDocDto> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = {
    traceparent: newTraceparent(),
    'x-request-id': newRequestId(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BFF_URL}/api/kb/docs`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`kb_upload_failed_${res.status}`);
  return (await res.json()) as KbDocDto;
}
```

- [ ] **Step 8: 跑 web 测试**

```bash
pnpm --filter @ai-office/web test
```

Expected: 全部 PASS（含既有用例）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/lib/trace.ts apps/web/src/lib/trace.test.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
git commit -m "feat(web): 请求注入 traceparent 与请求 ID

浏览器是链路的起点，此前 BFF 只能自建 root span，无法把用户的一次操作
与后续 BFF/runtime 日志串起来。现在所有 BFF 调用（含登录、注册与文件上传）
都带 W3C traceparent 与受约束的 x-request-id，BFF 直接续接父上下文。"
```

---

## Task 6: 数据模型、共享 DTO 与 Run.traceId 落库

**Files:**
- Modify: `apps/bff/prisma/schema.prisma`
- Modify: `packages/shared/src/dto.ts`
- Modify: `apps/bff/src/tasks/tasks.service.ts`
- Modify: `apps/bff/src/tasks/tasks.controller.ts`
- Modify: `apps/bff/src/admin/admin-tasks.service.ts`
- Test: `apps/bff/src/tasks/tasks.service.test.ts`
- Test: `apps/bff/src/tasks/tasks.controller.test.ts`
- Test: `apps/bff/src/admin/admin-tasks.service.test.ts`

- [ ] **Step 1: 改 Prisma schema 的既有模型**

`apps/bff/prisma/schema.prisma` 的 `Run` 改为：

```prisma
model Run {
  id        String    @id @default(uuid())
  taskId    String
  status    String    @default("running")
  startedAt DateTime  @default(now())
  endedAt   DateTime?
  // 发起本次运行的前端/BFF traceId；历史数据允许为空。
  traceId   String?
  task      Task      @relation(fields: [taskId], references: [id])
  steps     Step[]
  artifacts Artifact[]

  @@index([taskId])
  @@index([traceId])
  @@index([startedAt])
}
```

`Step` 的索引改为：

```prisma
  @@unique([runId, seq])
  @@index([ts])
```

`UsageRecord` 的索引改为：

```prisma
  @@index([tenantId, createdAt])
  @@index([status, createdAt])
  @@index([createdAt])
```

- [ ] **Step 2: 追加快照与告警模型**

在 `schema.prisma` 末尾追加：

```prisma
// 小时级指标快照：bucketStart 为整点 UTC；value 按 metric 语义为求和/均值/分位值。
model MetricBucket {
  id            String   @id @default(uuid())
  bucketStart   DateTime
  metric        String
  dimensionType String   @default("global") // global | model | tenant | tool
  dimensionId   String   @default("")
  value         Float
  count         Int      @default(0)
  updatedAt     DateTime @updatedAt

  @@unique([bucketStart, metric, dimensionType, dimensionId])
  @@index([metric, bucketStart])
  @@index([dimensionType, dimensionId, bucketStart])
}

model AlertRule {
  id              String   @id @default(uuid())
  key             String   @unique
  name            String
  metric          String
  comparator      String   // gt | lt
  threshold       Float
  windowMinutes   Int
  cooldownMinutes Int
  severity        String   // warning | critical
  enabled         Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model AlertEvent {
  id             String    @id @default(uuid())
  ruleId         String
  ruleName       String
  status         String    // firing | resolved
  value          Float
  message        String
  startedAt      DateTime
  resolvedAt     DateTime?
  notifiedAt     DateTime?
  deliveryStatus String?   // sent | failed | skipped
  deliveryError  String?
  // firing 时为 ruleId，resolved 置 null：借 PostgreSQL 唯一索引允许多 NULL，
  // 从数据库层保证每条规则最多一个未恢复事件，多实例并发也不会重复建。
  openKey        String?   @unique
  createdAt      DateTime  @default(now())

  @@index([ruleId, startedAt])
  @@index([status, startedAt])
  @@index([startedAt])
}
```

- [ ] **Step 3: 同步数据库与 Prisma Client**

```bash
pnpm --filter @ai-office/bff db:push
```

Expected: `Your database is now in sync with your Prisma schema`，并生成新的 Client。

- [ ] **Step 4: 写失败的服务端测试**

`apps/bff/src/tasks/tasks.service.test.ts` 在 `describe('TasksService')` 内新增：

```ts
  it('prepare 持久化 traceId，未提供时写 null', async () => {
    await svc.prepare('s1', 't1', 'u1', '目标', 'run1', 'trace-1');
    expect(ctx.db.runs[0]).toMatchObject({ id: 'run1', traceId: 'trace-1' });

    await svc.prepare('s1', 't1', 'u1', '目标', 'run2');
    expect(ctx.db.runs[1].traceId).toBeNull();
  });
```

`apps/bff/src/admin/admin-tasks.service.test.ts` 的 `RunSeed` 增加字段：

```ts
interface RunSeed {
  id: string;
  taskId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  traceId?: string | null;
  steps: StepSeed[];
}
```

`defaultRun` 增加：

```ts
  traceId: '0af7651916cd43dd8448eb211c80319c',
```

在 `describe('AdminTasksService')` 末尾新增：

```ts
  it('runDetail 回传 traceId，历史数据为 null', async () => {
    const { svc } = makeService();
    const detail = await svc.runDetail('r1', {}, actor);
    expect(detail.traceId).toBe('0af7651916cd43dd8448eb211c80319c');

    const legacy = makeService({ runs: [{ ...defaultRun, traceId: null }] });
    await expect(legacy.svc.runDetail('r1', {}, actor)).resolves.toMatchObject({ traceId: null });
  });
```

`apps/bff/src/tasks/tasks.controller.test.ts` 的 `stored` 增加 `runCreates`：

```ts
const stored: {
  steps: unknown[];
  messages: unknown[];
  runCreates: unknown[];
  runUpdates: unknown[];
  taskUpdates: unknown[];
  artifacts: unknown[];
} = { steps: [], messages: [], runCreates: [], runUpdates: [], taskUpdates: [], artifacts: [] };
```

`run.create` 改为：

```ts
  run: {
    create: async ({ data }: { data: unknown }) => {
      stored.runCreates.push(data);
      return { id: (data as { id?: string }).id ?? 'run1', ...(data as object) };
    },
    update: async (args: unknown) => {
      if (failRunUpdate) throw new Error('injected run.update failure');
      stored.runUpdates.push(args);
      return {};
    },
  },
```

`beforeEach` 增加：

```ts
  stored.runCreates.length = 0;
```

在 `describe('TasksController')` 末尾新增：

```ts
  it('run 落库当前请求的 traceId', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: {
        authorization: `Bearer ${token}`,
        traceparent: `00-${traceId}-b7ad6b7169203331-01`,
      },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(200);
    expect(stored.runCreates[0]).toMatchObject({ traceId });
  });
```

- [ ] **Step 5: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/tasks/tasks.service.test.ts src/admin/admin-tasks.service.test.ts src/tasks/tasks.controller.test.ts
```

Expected: 三条新用例 FAIL：`traceId` 为 `undefined`（服务未写入、DTO 未返回）。

- [ ] **Step 6: 让 TasksService 写入 traceId**

`apps/bff/src/tasks/tasks.service.ts` 的 `prepare` 签名增加可选参数：

```ts
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
    runId: string,
    traceId?: string | null,
  ): Promise<{ taskId: string; runId: string; tenantId: string; userId: string; messages: ChatMessage[] }> {
```

`tx.run.create` 改为：

```ts
          const run = await tx.run.create({
            data: { id: runId, taskId: task.id, status: 'running', traceId: traceId ?? null },
          });
```

- [ ] **Step 7: 控制器从当前上下文取 traceId**

`apps/bff/src/tasks/tasks.controller.ts` 的 telemetry import 改为：

```ts
import { currentTrace, endSpan, injectTraceparent, startSpan } from '@ai-office/telemetry';
```

`prepare` 调用改为：

```ts
      prepared = await this.tasks.prepare(
        sessionId,
        user.tenantId,
        user.sub,
        goal,
        runId,
        // onRequest 已建立请求 span；这里把同一条 trace 固化到 run，便于事后按 trace 反查。
        currentTrace()?.traceId ?? null,
      );
```

- [ ] **Step 8: 补共享 DTO**

`packages/shared/src/dto.ts` 的 `AdminRunDetailDto` 在 `taskId` 后增加：

```ts
  traceId: string | null;
```

在文件末尾（`AdminCreditsRequest` 之后）追加：

```ts
export type AdminOverviewRange = '24h' | '7d' | '30d';

export interface AdminOverviewKpiDto {
  runs: number;
  failedRuns: number;
  /** 已结束运行的成功率；窗口内没有已结束运行时为 null。 */
  successRate: number | null;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  unresolvedAlerts: number;
}

export interface AdminOverviewPointDto {
  bucketStart: string;
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  avgDurationMs: number | null;
}

export interface AdminOverviewModelCostDto {
  model: string;
  credits: number;
}

export interface AdminServiceHealthDto {
  name: string;
  up: boolean;
  checkedAt: string;
}

export interface AdminOverviewDto {
  range: AdminOverviewRange;
  current: AdminOverviewKpiDto;
  previous: AdminOverviewKpiDto;
  series: AdminOverviewPointDto[];
  modelCosts: AdminOverviewModelCostDto[];
  serviceHealth: AdminServiceHealthDto[];
  generatedAt: string;
}

export type AdminMetricGranularity = 'hour' | 'day';
export type AdminMetricDimensionType = 'global' | 'model' | 'tenant' | 'tool';

export interface AdminMetricPointDto {
  bucketStart: string;
  value: number;
  count: number;
}

export interface AdminMetricSeriesDto {
  metric: string;
  dimensionType: AdminMetricDimensionType;
  dimensionId: string;
  points: AdminMetricPointDto[];
}

export interface AdminMetricTimeseriesDto {
  from: string;
  to: string;
  granularity: AdminMetricGranularity;
  series: AdminMetricSeriesDto[];
}

export interface AdminAlertRuleDto {
  id: string;
  key: string;
  name: string;
  metric: string;
  comparator: 'gt' | 'lt';
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: 'warning' | 'critical';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAlertRulePatch {
  threshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
  severity?: 'warning' | 'critical';
  enabled?: boolean;
}

export interface AdminAlertEventDto {
  id: string;
  ruleId: string;
  ruleName: string;
  status: 'firing' | 'resolved';
  value: number;
  message: string;
  startedAt: string;
  resolvedAt: string | null;
  notifiedAt: string | null;
  deliveryStatus: 'sent' | 'failed' | 'skipped' | null;
  deliveryError: string | null;
}

export interface AdminAlertTestResultDto {
  deliveryStatus: 'sent' | 'failed' | 'skipped';
  deliveryError: string | null;
  notifiedAt: string | null;
}

export type AdminTimelineNodeKind =
  | 'accepted'
  | 'think'
  | 'tool'
  | 'confirm'
  | 'artifact'
  | 'notice'
  | 'finished';

export type AdminTimelineNodeStatus =
  | 'ok'
  | 'failed'
  | 'denied'
  | 'blocked'
  | 'running'
  | 'done';

export interface AdminTimelineNodeDto {
  /** step 事件用 step id；合成节点用 `${runId}:${kind}`，保证前端 key 稳定。 */
  id: string;
  kind: AdminTimelineNodeKind;
  label: string;
  status: AdminTimelineNodeStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface AdminRunTimelineDto {
  runId: string;
  status: string;
  traceId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  nodes: AdminTimelineNodeDto[];
  /** 节点超过 500 时只返回前 500，并置为 true。 */
  truncated: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    credits: number | null;
    models: unknown;
  } | null;
}
```

构建共享声明：

```bash
pnpm --filter @ai-office/shared build
```

Expected: `dist/index.d.ts` 中出现 `AdminRunTimelineDto` 与 `traceId: string | null`。

- [ ] **Step 9: 管理端运行详情返回 traceId**

`apps/bff/src/admin/admin-tasks.service.ts` 的 `runDetail` 返回值中，在 `taskId` 后增加：

```ts
      traceId: row.traceId,
```

- [ ] **Step 10: 跑 BFF 测试与类型检查**

```bash
pnpm --filter @ai-office/bff test -- src/tasks/tasks.service.test.ts src/admin/admin-tasks.service.test.ts src/tasks/tasks.controller.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 11: 提交**

```bash
git add apps/bff/prisma/schema.prisma packages/shared/src/dto.ts apps/bff/src/tasks/tasks.service.ts apps/bff/src/tasks/tasks.controller.ts apps/bff/src/admin/admin-tasks.service.ts apps/bff/src/tasks/tasks.service.test.ts apps/bff/src/tasks/tasks.controller.test.ts apps/bff/src/admin/admin-tasks.service.test.ts
git commit -m "feat(observability): 建立指标快照与告警数据模型

可观测性此前只有进程内 Prometheus 指标，进程重启即丢失，也无法按小时
回溯或驱动告警。现在补上 MetricBucket/AlertRule/AlertEvent 三张表与查询
索引，并把请求 traceId 固化到 Run：一次运行可以从浏览器一路追到数据库。
openKey 唯一索引从存储层保证每条规则最多一个未恢复事件。"
```

---

## Task 7: 参数类型化与 secret 脱敏

**Files:**
- Modify: `packages/shared/src/dto.ts`
- Modify: `apps/bff/src/settings/settings.service.ts`
- Test: `apps/bff/src/settings/settings.service.test.ts`
- Test: `apps/bff/src/admin/admin.endpoints.test.ts`
- Modify: `apps/web/src/lib/admin-api.ts`
- Modify: `apps/web/src/app/admin/settings/page.tsx`

- [ ] **Step 1: 共享 DTO 改为类型化联合**

`packages/shared/src/dto.ts` 中把现有的 `AdminSettingDto` 整段替换为：

```ts
export type SettingType = 'number' | 'string' | 'boolean' | 'secret';

interface AdminSettingBaseDto {
  key: string;
  source: SettingSource;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AdminNumberSettingDto extends AdminSettingBaseDto {
  type: 'number';
  value: number;
  min: number;
  max: number;
}

export interface AdminStringSettingDto extends AdminSettingBaseDto {
  type: 'string';
  value: string;
  maxLength: number;
}

export interface AdminBooleanSettingDto extends AdminSettingBaseDto {
  type: 'boolean';
  value: boolean;
}

export interface AdminSecretSettingDto extends AdminSettingBaseDto {
  type: 'secret';
  /** 永不回传明文：已配置时为脱敏串，未配置为 null。 */
  maskedValue: string | null;
  configured: boolean;
}

export type AdminSettingDto =
  | AdminNumberSettingDto
  | AdminStringSettingDto
  | AdminBooleanSettingDto
  | AdminSecretSettingDto;

/** PUT 请求体 value：secret 传 null 表示显式清空。 */
export type AdminSettingValue = number | string | boolean | null;
```

构建共享声明：

```bash
pnpm --filter @ai-office/shared build
```

Expected: `dist/index.d.ts` 中出现 `AdminSecretSettingDto`。

- [ ] **Step 2: 写失败的 settings 测试**

`apps/bff/src/settings/settings.service.test.ts` 在 `describe('SettingsService')` 末尾新增：

```ts
  it('按类型解析布尔、字符串与 secret，且不泄露明文', async () => {
    const { svc } = makeService();
    process.env.ALERTS_ENABLED = 'false';
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/alert';
    process.env.ALERT_WEBHOOK_SECRET = 'secret-token-9876';
    try {
      const all = await svc.getAll();
      const enabled = all.find((s) => s.key === 'alertsEnabled')!;
      const url = all.find((s) => s.key === 'alertWebhookUrl')!;
      const secret = all.find((s) => s.key === 'alertWebhookSecret')!;
      expect(enabled).toMatchObject({ type: 'boolean', value: false, source: 'env' });
      expect(url).toMatchObject({
        type: 'string',
        value: 'https://hooks.example.com/alert',
        source: 'env',
      });
      expect(secret).toMatchObject({
        type: 'secret',
        configured: true,
        maskedValue: '****9876',
        source: 'env',
      });
      expect(JSON.stringify(secret)).not.toContain('secret-token-9876');
    } finally {
      delete process.env.ALERTS_ENABLED;
      delete process.env.ALERT_WEBHOOK_URL;
      delete process.env.ALERT_WEBHOOK_SECRET;
    }
  });

  it('secret 更新与审计都只出现脱敏值', async () => {
    const { svc, audits } = makeService();
    const saved = await svc.update('alertWebhookSecret', 'secret-token-9876', actor);
    expect(saved).toMatchObject({
      type: 'secret',
      configured: true,
      maskedValue: '****9876',
      source: 'db',
    });
    expect(JSON.stringify(saved)).not.toContain('secret-token-9876');
    expect(JSON.stringify(audits)).not.toContain('secret-token-9876');

    const cleared = await svc.update('alertWebhookSecret', null, actor);
    expect(cleared).toMatchObject({
      type: 'secret',
      configured: false,
      maskedValue: null,
      source: 'db',
    });
  });

  it('显式清空 secret 不会被 env 复活', async () => {
    const { svc } = makeService();
    process.env.ALERT_WEBHOOK_SECRET = 'env-secret-1234';
    try {
      await svc.update('alertWebhookSecret', null, actor);
      const item = (await svc.getAll()).find((s) => s.key === 'alertWebhookSecret')!;
      expect(item).toMatchObject({ configured: false, source: 'db' });
      expect(JSON.stringify(item)).not.toContain('env-secret-1234');
    } finally {
      delete process.env.ALERT_WEBHOOK_SECRET;
    }
  });

  it('alertWebhookUrl 仅接受 http/https', async () => {
    const { svc } = makeService();
    await expect(svc.update('alertWebhookUrl', 'ftp://example.com', actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('alertWebhookUrl', 'not-a-url', actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.update('alertWebhookUrl', 'https://example.com/hook', actor)).resolves.toMatchObject(
      { value: 'https://example.com/hook' },
    );
  });

  it('getAlertSettings 返回生效配置', async () => {
    const { svc } = makeService();
    await svc.update('alertsEnabled', false, actor);
    await svc.update('alertWebhookUrl', 'https://example.com/hook', actor);
    await svc.update('alertWebhookSecret', 'secret-token-9876', actor);
    await expect(svc.getAlertSettings()).resolves.toEqual({
      enabled: false,
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-token-9876',
    });
  });
```

`apps/bff/src/admin/admin.endpoints.test.ts` 在 `describe('参数配置接口')` 末尾新增：

```ts
  it('布尔与 secret 参数按类型返回，secret 不泄露明文', async () => {
    const enabled = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/alertsEnabled',
      headers: auth('admin'),
      payload: { value: false },
    });
    expect(enabled.statusCode).toBe(200);
    expect(JSON.parse(enabled.payload)).toMatchObject({
      key: 'alertsEnabled',
      type: 'boolean',
      value: false,
      source: 'db',
    });

    const secret = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/alertWebhookSecret',
      headers: auth('admin'),
      payload: { value: 'secret-token-9876' },
    });
    expect(secret.statusCode).toBe(200);
    expect(JSON.parse(secret.payload)).toMatchObject({
      type: 'secret',
      configured: true,
      maskedValue: '****9876',
    });
    expect(secret.payload).not.toContain('secret-token-9876');
  });

  it('类型不匹配返回 400 invalid_value', async () => {
    const res = await settingsApp.inject({
      method: 'PUT',
      url: '/api/admin/settings/alertsEnabled',
      headers: auth('admin'),
      payload: { value: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ message: 'invalid_value' });
  });
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/settings/settings.service.test.ts src/admin/admin.endpoints.test.ts
```

Expected: 新用例 FAIL：`type`/`getAlertSettings` 不存在、secret 明文被返回。

- [ ] **Step 4: 重写 SettingsService**

用下面的完整内容替换 `apps/bff/src/settings/settings.service.ts`：

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminSettingDto,
  AdminSettingValue,
  RunConfig,
  SettingSource,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

export interface NumberSettingSpec {
  type: 'number';
  min: number;
  max: number;
  fallback: number;
  env?: string;
}

export interface StringSettingSpec {
  type: 'string';
  fallback: string;
  maxLength: number;
  env?: string;
  validate?: (value: string) => boolean;
}

export interface BooleanSettingSpec {
  type: 'boolean';
  fallback: boolean;
  env?: string;
}

export interface SecretSettingSpec {
  type: 'secret';
  fallback: string;
  maxLength: number;
  env?: string;
}

export type SettingSpec =
  | NumberSettingSpec
  | StringSettingSpec
  | BooleanSettingSpec
  | SecretSettingSpec;

/** 空串是合法值（表示停用 Webhook）；非空时只允许 http/https，防止 SSRF 到 file 等协议。 */
function isHttpUrlOrEmpty(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const SETTING_SPECS = {
  maxRounds: { type: 'number', min: 1, max: 32, fallback: 8 },
  confirmTimeoutMs: { type: 'number', min: 1000, max: 600000, fallback: 120000, env: 'CONFIRM_TIMEOUT_MS' },
  codeExecTimeoutMs: { type: 'number', min: 100, max: 60000, fallback: 5000, env: 'CODE_EXEC_TIMEOUT_MS' },
  kbChunkSize: { type: 'number', min: 100, max: 4000, fallback: 800, env: 'KB_CHUNK_SIZE' },
  kbChunkOverlap: { type: 'number', min: 0, max: 1000, fallback: 150, env: 'KB_CHUNK_OVERLAP' },
  alertsEnabled: { type: 'boolean', fallback: true, env: 'ALERTS_ENABLED' },
  alertWebhookUrl: {
    type: 'string',
    fallback: '',
    maxLength: 2048,
    env: 'ALERT_WEBHOOK_URL',
    validate: isHttpUrlOrEmpty,
  },
  alertWebhookSecret: {
    type: 'secret',
    fallback: '',
    maxLength: 256,
    env: 'ALERT_WEBHOOK_SECRET',
  },
} satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTING_SPECS;

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_SPECS, value);
}

interface Resolved {
  value: AdminSettingValue;
  source: SettingSource;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** 只暴露尾部 4 位，短密钥连长度都不透露。 */
function maskSecret(value: string): string {
  if (value === '') return '';
  return value.length >= 8 ? `****${value.slice(-4)}` : '****';
}

/** 管理端参数配置：DB 覆盖 → env → 默认值的优先级解析，写操作与审计同事务。 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getAll(): Promise<AdminSettingDto[]> {
    return Promise.all((Object.keys(SETTING_SPECS) as SettingKey[]).map((key) => this.toDto(key)));
  }

  async getRunConfig(): Promise<Required<RunConfig>> {
    const [maxRounds, confirmTimeoutMs, codeExecTimeoutMs] = await Promise.all([
      this.resolveNumber('maxRounds'),
      this.resolveNumber('confirmTimeoutMs'),
      this.resolveNumber('codeExecTimeoutMs'),
    ]);
    return { maxRounds, confirmTimeoutMs, codeExecTimeoutMs };
  }

  async getKbConfig(): Promise<{ chunkSize: number; chunkOverlap: number }> {
    const [size, overlap] = await Promise.all([
      this.resolveNumber('kbChunkSize'),
      this.resolveNumber('kbChunkOverlap'),
    ]);
    // 脏 env 与 DB 组合也可能出现 overlap ≥ size；回落到默认 overlap 并保证小于 size。
    const chunkOverlap =
      overlap < size
        ? overlap
        : Math.min(SETTING_SPECS.kbChunkOverlap.fallback, Math.max(0, size - 1));
    return { chunkSize: size, chunkOverlap };
  }

  /** 告警任务读取生效配置；secret 仅在此处解密后的进程内使用，不进入日志。 */
  async getAlertSettings(): Promise<{
    enabled: boolean;
    webhookUrl: string;
    webhookSecret: string;
  }> {
    const [enabled, url, secret] = await Promise.all([
      this.resolve('alertsEnabled'),
      this.resolve('alertWebhookUrl'),
      this.resolve('alertWebhookSecret'),
    ]);
    return {
      enabled: enabled.value as boolean,
      webhookUrl: url.value as string,
      webhookSecret: secret.value as string,
    };
  }

  async update(key: string, raw: unknown, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    const value = this.validate(key, raw);

    if (key === 'kbChunkOverlap') {
      const size = await this.resolveNumber('kbChunkSize');
      if ((value as number) >= size) throw new BadRequestException('invalid_kbChunkOverlap');
    }

    if (key === 'kbChunkSize') {
      // 与当前生效的 overlap 联合校验，避免落库 overlap ≥ size 的不一致状态。
      const overlap = await this.resolveNumber('kbChunkOverlap');
      if (overlap >= (value as number)) throw new BadRequestException('invalid_kbChunkSize');
    }

    // secret 显式清空（null/空串）写成 DB 空串：优先级高于 env，避免“清空后被 env 复活”。
    const stored: number | string | boolean = value === null ? '' : value;
    const auditSummary =
      SETTING_SPECS[key].type === 'secret'
        ? { value: value === null || value === '' ? null : maskSecret(String(value)) }
        : { value: stored };

    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: stored, updatedBy: actor.id },
        update: { value: stored, updatedBy: actor.id },
      });
      await this.audit.write(tx, actor, {
        action: 'setting.update',
        targetType: 'setting',
        targetId: key,
        summary: auditSummary,
      });
    });
    return this.toDto(key);
  }

  async reset(key: string, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    await this.prisma.$transaction(async (tx) => {
      await tx.setting.deleteMany({ where: { key } });
      await this.audit.write(tx, actor, {
        action: 'setting.reset',
        targetType: 'setting',
        targetId: key,
      });
    });
    return this.toDto(key);
  }

  private validate(key: SettingKey, raw: unknown): AdminSettingValue {
    const spec = SETTING_SPECS[key];
    switch (spec.type) {
      case 'number':
        if (
          typeof raw !== 'number' ||
          !Number.isSafeInteger(raw) ||
          raw < spec.min ||
          raw > spec.max
        ) {
          throw new BadRequestException('invalid_value');
        }
        return raw;
      case 'boolean':
        if (typeof raw !== 'boolean') throw new BadRequestException('invalid_value');
        return raw;
      case 'string':
        if (
          typeof raw !== 'string' ||
          raw.length > spec.maxLength ||
          (spec.validate !== undefined && !spec.validate(raw))
        ) {
          throw new BadRequestException('invalid_value');
        }
        return raw;
      case 'secret':
        // null 与空串都表示显式清空；不 trim，密钥必须逐字节一致。
        if (raw === null) return null;
        if (typeof raw !== 'string' || raw.length > spec.maxLength) {
          throw new BadRequestException('invalid_value');
        }
        return raw;
    }
  }

  private async resolveNumber(key: SettingKey): Promise<number> {
    return (await this.resolve(key)).value as number;
  }

  private async resolve(key: SettingKey): Promise<Resolved> {
    const spec = SETTING_SPECS[key];
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (row) {
      const value = this.fromStored(spec, row.value);
      if (value !== undefined) {
        return {
          value,
          source: 'db',
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        };
      }
    }

    if (spec.env) {
      const value = this.fromEnv(spec, process.env[spec.env]);
      if (value !== undefined) {
        return { value, source: 'env', updatedAt: null, updatedBy: null };
      }
    }

    return { value: spec.fallback, source: 'default', updatedAt: null, updatedBy: null };
  }

  /** undefined 表示「该来源的值不可用，继续回落」；空串是合法值。 */
  private fromStored(spec: SettingSpec, raw: unknown): AdminSettingValue | undefined {
    switch (spec.type) {
      case 'number':
        return typeof raw === 'number' &&
          Number.isSafeInteger(raw) &&
          raw >= spec.min &&
          raw <= spec.max
          ? raw
          : undefined;
      case 'boolean':
        return typeof raw === 'boolean' ? raw : undefined;
      case 'string':
        return typeof raw === 'string' &&
          raw.length <= spec.maxLength &&
          (spec.validate === undefined || spec.validate(raw))
          ? raw
          : undefined;
      case 'secret':
        return typeof raw === 'string' && raw.length <= spec.maxLength ? raw : undefined;
    }
  }

  private fromEnv(spec: SettingSpec, raw: string | undefined): AdminSettingValue | undefined {
    // 空/空白 env 视为未设置：Number('') === 0，否则会把「清空变量」误解析为 0。
    if (raw === undefined || raw.trim() === '') return undefined;
    switch (spec.type) {
      case 'number': {
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max
          ? value
          : undefined;
      }
      case 'boolean': {
        const value = raw.trim().toLowerCase();
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
        return undefined;
      }
      case 'string':
        return raw.length <= spec.maxLength &&
          (spec.validate === undefined || spec.validate(raw))
          ? raw
          : undefined;
      case 'secret':
        return raw.length <= spec.maxLength ? raw : undefined;
    }
  }

  private async toDto(key: SettingKey): Promise<AdminSettingDto> {
    const spec = SETTING_SPECS[key];
    const resolved = await this.resolve(key);
    const base = {
      key,
      source: resolved.source,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedBy: resolved.updatedBy,
    };

    switch (spec.type) {
      case 'number':
        return { ...base, type: 'number', value: resolved.value as number, min: spec.min, max: spec.max };
      case 'boolean':
        return { ...base, type: 'boolean', value: resolved.value as boolean };
      case 'string':
        return { ...base, type: 'string', value: resolved.value as string, maxLength: spec.maxLength };
      case 'secret': {
        const value = resolved.value as string;
        return {
          ...base,
          type: 'secret',
          configured: value !== '',
          maskedValue: value === '' ? null : maskSecret(value),
        };
      }
    }
  }
}
```

- [ ] **Step 5: 跑 settings 测试**

```bash
pnpm --filter @ai-office/bff test -- src/settings/settings.service.test.ts src/admin/admin.endpoints.test.ts src/tasks
```

Expected: 全部 PASS（`src/tasks` 用来确认 `getRunConfig` 调用方未被破坏）。

- [ ] **Step 6: 更新 web 管理端 API 签名**

`apps/web/src/lib/admin-api.ts` 的既有 `@ai-office/shared` import 列表中加入 `AdminSettingValue`（放在 `AdminSettingDto` 之后）。

`updateAdminSetting` 改为：

```ts
export function updateAdminSetting(key: string, value: AdminSettingValue): Promise<AdminSettingDto> {
  return request(`/api/admin/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}
```

- [ ] **Step 7: 参数页按类型渲染**

用下面的完整内容替换 `apps/web/src/app/admin/settings/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminSettingDto, AdminSettingValue, SettingSource } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminSettings,
  resetAdminSetting,
  updateAdminSetting,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

const SOURCE_LABEL: Record<SettingSource, string> = {
  db: '数据库',
  env: '环境变量',
  default: '默认值',
};

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

/** 生效值只读展示；secret 永远只显示脱敏串。 */
function displayValue(item: AdminSettingDto): string {
  switch (item.type) {
    case 'number':
      return String(item.value);
    case 'string':
      return item.value === '' ? '（空）' : item.value;
    case 'boolean':
      return item.value ? '启用' : '停用';
    case 'secret':
      return item.configured ? (item.maskedValue ?? '已配置') : '未配置';
  }
}

/** 输入框初值：secret 永不预填，避免浏览器/插件读到明文。 */
function initialDraft(item: AdminSettingDto): string {
  switch (item.type) {
    case 'number':
      return String(item.value);
    case 'string':
      return item.value;
    case 'boolean':
      return String(item.value);
    case 'secret':
      return '';
  }
}

function rangeText(item: AdminSettingDto): string {
  switch (item.type) {
    case 'number':
      return `${item.min}–${item.max}`;
    case 'string':
      return `≤ ${item.maxLength} 字符`;
    default:
      return '—';
  }
}

type Parsed = { value: AdminSettingValue } | { error: string };

function parseDraft(item: AdminSettingDto, raw: string): Parsed {
  if (item.type === 'number') {
    const text = raw.trim();
    // 空串不能被 Number 隐式解析为 0，必须显式拒绝。
    const value = text ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < item.min || value > item.max) {
      return { error: `${item.key} 必须是 ${item.min}–${item.max} 的整数` };
    }
    return { value };
  }
  if (item.type === 'boolean') return { value: raw === 'true' };
  if (item.type === 'string') {
    if (raw.length > item.maxLength) {
      return { error: `${item.key} 不能超过 ${item.maxLength} 个字符` };
    }
    if (item.key === 'alertWebhookUrl' && raw !== '') {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return { error: 'Webhook 地址只支持 http/https' };
        }
      } catch {
        return { error: 'Webhook 地址格式不合法' };
      }
    }
    return { value: raw };
  }
  if (raw.trim() === '') {
    return { error: '请输入新的密钥，或使用“清空密钥”' };
  }
  if (raw.length > item.maxLength) {
    return { error: `${item.key} 不能超过 ${item.maxLength} 个字符` };
  }
  return { value: raw };
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminSettingDto[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  // 记录正在写的参数 key：非 null 时禁用所有输入与按钮，避免并发写互相覆盖
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const inFlight = useRef(false);
  // 有未保存输入的参数 key：刷新时保留其草稿，避免被服务端值静默覆盖。
  const dirtyRef = useRef<Set<string>>(new Set());

  function markDirty(key: string): void {
    dirtyRef.current.add(key);
  }

  function clearDirty(key: string): void {
    dirtyRef.current.delete(key);
  }

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return true;
      }
      if (isForbidden(err)) {
        router.push('/');
        return true;
      }
      setError(adminErrorText(err));
      return false;
    },
    [router],
  );

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const rows = await listAdminSettings();
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setItems(rows);
      // 仅保留有未保存修改的行，其余以服务端值为准。
      setDraft((prev) => {
        const next: Record<string, string> = {};
        for (const r of rows) {
          next[r.key] = dirtyRef.current.has(r.key)
            ? (prev[r.key] ?? initialDraft(r))
            : initialDraft(r);
        }
        return next;
      });
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的闭包覆盖后续状态
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshAfterWrite() {
    // 写操作已成功，先给出明确的成功提示，避免刷新失败被误判为操作失败而重复提交
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  async function save(item: AdminSettingDto) {
    if (inFlight.current) return;
    setError('');
    setNotice('');
    const parsed = parseDraft(item, draft[item.key] ?? '');
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }

    // secret 的新值绝不出现在确认文案里。
    const after = item.type === 'secret' ? '（新密钥，内容隐藏）' : String(parsed.value);
    if (!window.confirm(`确认把 ${item.key} 从 ${displayValue(item)} 改为 ${after}？`)) return;

    inFlight.current = true;
    setBusyKey(item.key);
    try {
      await updateAdminSetting(item.key, parsed.value);
      // 保存成功后才清除 dirty；失败时保留未保存的输入。
      clearDirty(item.key);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  }

  async function reset(item: AdminSettingDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认清除 ${item.key} 的数据库覆盖，恢复环境变量/默认值？`)) return;
    inFlight.current = true;
    setBusyKey(item.key);
    setError('');
    setNotice('');
    try {
      await resetAdminSetting(item.key);
      // 恢复默认成功后清除 dirty；失败时保留未保存的输入。
      clearDirty(item.key);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  }

  async function clearSecret(item: AdminSettingDto) {
    if (inFlight.current) return;
    if (
      !window.confirm(
        `确认清空 ${item.key}？清空会覆盖环境变量中的同名密钥，Webhook 将不再签名。`,
      )
    ) {
      return;
    }
    inFlight.current = true;
    setBusyKey(item.key);
    setError('');
    setNotice('');
    try {
      await updateAdminSetting(item.key, null);
      clearDirty(item.key);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  }

  const busy = busyKey !== null;

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">参数配置</h1>
            <p className="page-sub">
              修改即时生效：运行参数随下一次 run 下发，KB 参数随下一次摄取下发；密钥只显示脱敏值。
            </p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {notice && (
          <div
            className="banner"
            role="status"
            style={{ marginBottom: 16, background: 'var(--surface-2)', border: '1px solid var(--line)' }}
          >
            {notice}
          </div>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">暂无参数</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>参数</th>
                <th>生效值 / 修改</th>
                <th>来源</th>
                <th>范围</th>
                <th>更新人</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td>
                    {item.key}
                    <div className="page-sub" style={{ marginTop: 4, fontSize: 12 }}>
                      {item.type === 'secret' ? '密钥' : item.type}
                    </div>
                  </td>
                  <td>
                    {item.type === 'boolean' ? (
                      <select
                        className="admin-input"
                        style={{ width: 120 }}
                        value={draft[item.key] ?? 'true'}
                        disabled={busy}
                        onChange={(e) => {
                          markDirty(item.key);
                          setDraft({ ...draft, [item.key]: e.target.value });
                        }}
                      >
                        <option value="true">启用</option>
                        <option value="false">停用</option>
                      </select>
                    ) : (
                      <input
                        type={item.type === 'number' ? 'number' : item.type === 'secret' ? 'password' : 'text'}
                        min={item.type === 'number' ? item.min : undefined}
                        max={item.type === 'number' ? item.max : undefined}
                        step={item.type === 'number' ? 1 : undefined}
                        className="admin-input"
                        style={{ width: item.type === 'string' ? 280 : 180 }}
                        placeholder={
                          item.type === 'secret'
                            ? item.configured
                              ? `已配置（${item.maskedValue}），留空不修改`
                              : '未配置'
                            : undefined
                        }
                        value={draft[item.key] ?? ''}
                        disabled={busy}
                        onChange={(e) => {
                          markDirty(item.key);
                          setDraft({ ...draft, [item.key]: e.target.value });
                        }}
                      />
                    )}
                    <div className="page-sub" style={{ marginTop: 4, fontSize: 12 }}>
                      当前：{displayValue(item)}
                    </div>
                  </td>
                  <td>{SOURCE_LABEL[item.source] ?? item.source}</td>
                  <td>{rangeText(item)}</td>
                  <td>{item.updatedBy || '—'}</td>
                  <td>{formatTime(item.updatedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn primary"
                      disabled={busy}
                      onClick={() => void save(item)}
                    >
                      保存
                    </button>{' '}
                    {item.type === 'secret' && item.configured && (
                      <>
                        <button
                          type="button"
                          className="admin-btn"
                          disabled={busy}
                          onClick={() => void clearSecret(item)}
                        >
                          清空密钥
                        </button>{' '}
                      </>
                    )}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy || item.source !== 'db'}
                      onClick={() => void reset(item)}
                    >
                      恢复默认
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: 跑 BFF 与 web 校验**

```bash
pnpm --filter @ai-office/bff test -- src/settings src/admin/admin.endpoints.test.ts src/tasks
pnpm --filter @ai-office/bff typecheck
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web exec tsc --noEmit
```

Expected: 全部 PASS；两个 typecheck 无输出。

- [ ] **Step 9: 提交**

```bash
git add packages/shared/src/dto.ts apps/bff/src/settings apps/bff/src/admin/admin.endpoints.test.ts apps/web/src/lib/admin-api.ts apps/web/src/app/admin/settings/page.tsx
git commit -m "feat(settings): 参数类型化并脱敏密钥

告警需要布尔开关、Webhook 地址与签名密钥，而参数系统此前只支持整数。
现在按 number/string/boolean/secret 四类声明、校验与渲染；secret 永不
通过 API 或审计回传明文，显式清空写 DB 空串以覆盖 env，避免“清空后被
环境变量复活”。Webhook 地址在服务端与页面双重限制为 http/https。"
```

---

## Task 8: 小时级指标快照与保留策略

**Files:**
- Create: `apps/bff/src/metrics/rollup.ts`
- Test: `apps/bff/src/metrics/rollup.test.ts`
- Create: `apps/bff/src/metrics/leader-lock.ts`
- Test: `apps/bff/src/metrics/leader-lock.test.ts`
- Create: `apps/bff/src/metrics/metrics.sweeper.ts`
- Test: `apps/bff/src/metrics/metrics.sweeper.test.ts`
- Create: `apps/bff/src/metrics/metrics.module.ts`
- Modify: `apps/bff/src/app.module.ts`

- [ ] **Step 1: 写失败的纯聚合测试**

`apps/bff/src/metrics/rollup.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ModelPriceDto } from '@ai-office/shared';
import {
  aggregateRunEnds,
  aggregateRunStarts,
  aggregateToolCalls,
  aggregateUsage,
  allocateModelCredits,
  hourStartOf,
  parseModelUsage,
} from './rollup';

const H = new Date('2026-10-20T08:00:00.000Z');
const price = (input: number, output: number): ModelPriceDto => ({
  inputMilliCreditsPer1k: input,
  outputMilliCreditsPer1k: output,
});

function find(
  buckets: ReturnType<typeof aggregateRunStarts>,
  metric: string,
  dimensionType: string,
  dimensionId = '',
) {
  return buckets.find(
    (b) =>
      b.metric === metric &&
      b.dimensionType === dimensionType &&
      b.dimensionId === dimensionId,
  );
}

describe('指标快照聚合', () => {
  it('按 UTC 整点归档，并同时产出 global 与 tenant 维度', () => {
    expect(hourStartOf(new Date('2026-10-20T08:59:59.999Z')).toISOString()).toBe(
      '2026-10-20T08:00:00.000Z',
    );

    const buckets = aggregateRunStarts(
      [
        { tenantId: 't1', startedAt: new Date('2026-10-20T08:10:00Z') },
        { tenantId: 't1', startedAt: new Date('2026-10-20T08:50:00Z') },
        // 下一小时的数据不属于本桶。
        { tenantId: 't2', startedAt: new Date('2026-10-20T09:00:00Z') },
      ],
      H,
    );

    expect(buckets).toEqual([
      {
        bucketStart: H,
        metric: 'runs_started',
        dimensionType: 'global',
        dimensionId: '',
        value: 2,
        count: 0,
      },
      {
        bucketStart: H,
        metric: 'runs_started',
        dimensionType: 'tenant',
        dimensionId: 't1',
        value: 2,
        count: 0,
      },
    ]);
  });

  it('终态计数与时长只统计 done/failed', () => {
    const buckets = aggregateRunEnds(
      [
        {
          tenantId: 't1',
          status: 'done',
          startedAt: new Date('2026-10-20T08:00:00Z'),
          endedAt: new Date('2026-10-20T08:00:01Z'),
        },
        {
          tenantId: 't1',
          status: 'failed',
          startedAt: new Date('2026-10-20T08:10:00Z'),
          endedAt: new Date('2026-10-20T08:10:02Z'),
        },
        {
          tenantId: 't2',
          status: 'running',
          startedAt: new Date('2026-10-20T08:20:00Z'),
          endedAt: new Date('2026-10-20T08:20:03Z'),
        },
      ],
      H,
    );

    expect(find(buckets, 'runs_done', 'global')).toMatchObject({ value: 1, count: 0 });
    expect(find(buckets, 'runs_failed', 'global')).toMatchObject({ value: 1, count: 0 });
    expect(find(buckets, 'run_duration_ms', 'global')).toMatchObject({ value: 3000, count: 2 });
    expect(find(buckets, 'run_duration_ms', 'tenant', 't1')).toMatchObject({
      value: 3000,
      count: 2,
    });
    expect(find(buckets, 'runs_done', 'tenant', 't2')).toBeUndefined();
  });

  it('token 按 global/model/tenant 聚合，积分按价格比例分摊到模型', () => {
    const buckets = aggregateUsage(
      [
        {
          tenantId: 't1',
          inputTokens: 1500,
          outputTokens: 500,
          credits: 10,
          models: [
            { model: 'a', input: 1000, output: 0 },
            { model: 'b', input: 500, output: 500 },
          ],
        },
      ],
      { a: price(1000, 1000), b: price(1000, 1000) },
      H,
    );

    expect(find(buckets, 'input_tokens', 'global')).toMatchObject({ value: 1500 });
    expect(find(buckets, 'output_tokens', 'global')).toMatchObject({ value: 500 });
    expect(find(buckets, 'input_tokens', 'tenant', 't1')).toMatchObject({ value: 1500 });
    expect(find(buckets, 'credits', 'global')).toMatchObject({ value: 10 });
    expect(find(buckets, 'input_tokens', 'model', 'a')).toMatchObject({ value: 1000 });
    expect(find(buckets, 'output_tokens', 'model', 'b')).toMatchObject({ value: 500 });
    expect(find(buckets, 'credits', 'model', 'a')).toMatchObject({ value: 5 });
    expect(find(buckets, 'credits', 'model', 'b')).toMatchObject({ value: 5 });
  });

  it('缺价格时积分全部落到第一个模型，未结算记录不计积分', () => {
    const models = parseModelUsage([
      { model: 'unknown', input: 10, output: 0 },
      { model: 'known', input: 10, output: 0 },
      { model: '', input: 10, output: 0 },
      { model: 'zero', input: 0, output: 0 },
      'bad',
    ]);
    expect(models).toEqual([
      { model: 'unknown', input: 10, output: 0 },
      { model: 'known', input: 10, output: 0 },
    ]);
    expect(allocateModelCredits(models, {}, 7)).toEqual([{ model: 'unknown', credits: 7 }]);

    const buckets = aggregateUsage(
      [
        {
          tenantId: 't1',
          inputTokens: 1,
          outputTokens: 1,
          credits: null,
          models: [{ model: 'a', input: 1, output: 1 }],
        },
      ],
      {},
      H,
    );
    expect(find(buckets, 'credits', 'global')).toBeUndefined();
    expect(find(buckets, 'credits', 'model', 'a')).toBeUndefined();
  });

  it('工具调用按 tool_result.ok 统计失败，并截断超长工具名', () => {
    const long = 'x'.repeat(80);
    const buckets = aggregateToolCalls(
      [
        { payload: { tool: 'web.search', ok: true } },
        { payload: { tool: 'web.search', ok: false } },
        { payload: { tool: long, ok: true } },
        { payload: null },
        { payload: { ok: true } },
      ],
      H,
    );

    expect(find(buckets, 'tool_calls', 'tool', 'web.search')).toMatchObject({ value: 2 });
    expect(find(buckets, 'tool_failures', 'tool', 'web.search')).toMatchObject({ value: 1 });
    const truncated = buckets.find(
      (b) => b.metric === 'tool_calls' && b.dimensionId.startsWith('x'.repeat(40)),
    );
    expect(truncated?.dimensionId).toHaveLength(64);
    expect(buckets.filter((b) => b.dimensionId === long)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 写失败的选主与 sweeper 测试**

`apps/bff/src/metrics/leader-lock.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { RedisLeaderLock, type RedisLike } from './leader-lock';

describe('RedisLeaderLock', () => {
  it('用 SET key value PX ttl NX 抢锁', async () => {
    const set = vi.fn(async () => 'OK' as const);
    const lock = new RedisLeaderLock({ set, disconnect: () => undefined } as RedisLike);
    await expect(lock.acquire('k', 55_000)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('k', expect.any(String), 'PX', 55_000, 'NX');
  });

  it('未抢到锁返回 false', async () => {
    const lock = new RedisLeaderLock({
      set: async () => null,
      disconnect: () => undefined,
    });
    await expect(lock.acquire('k', 55_000)).resolves.toBe(false);
  });

  it('未配置或 Redis 异常时 fail-open 执行', async () => {
    const warn = vi.fn();
    const noRedis = new RedisLeaderLock(null, { warn });
    await expect(noRedis.acquire('k', 55_000)).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();

    const broken = new RedisLeaderLock(
      {
        set: async () => {
          throw new Error('redis down');
        },
        disconnect: () => undefined,
      },
      { warn },
    );
    await expect(broken.acquire('k', 55_000)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
```

`apps/bff/src/metrics/metrics.sweeper.test.ts`：

```ts
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsSweeper } from './metrics.sweeper';
import type { PrismaService } from '../db/prisma.service';
import type { LeaderLock } from './leader-lock';
import { createBffMetrics } from '../observability/observability.metrics';

const NOW = new Date('2026-10-20T10:35:00.000Z');

interface SeedRun {
  id: string;
  tenantId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

function makePrisma(runs: SeedRun[] = []) {
  const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const deletes: Array<{ where: Record<string, unknown> }> = [];
  const alertDeletes: Array<{ where: Record<string, unknown> }> = [];
  let runQueries = 0;

  const view = (r: SeedRun) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    task: { session: { tenantId: r.tenantId } },
  });

  const db = {
    run: {
      findMany: async ({ where }: any) => {
        runQueries += 1;
        if (where.startedAt) {
          return runs
            .filter(
              (r) => r.startedAt >= where.startedAt.gte && r.startedAt < where.startedAt.lt,
            )
            .map(view);
        }
        return runs
          .filter(
            (r) =>
              r.endedAt !== null &&
              r.endedAt >= where.endedAt.gte &&
              r.endedAt < where.endedAt.lt &&
              where.status.in.includes(r.status),
          )
          .map(view);
      },
    },
    usageRecord: { findMany: async () => [] },
    step: { findMany: async () => [] },
    modelPrice: { findMany: async () => [] },
    metricBucket: {
      upsert: async (args: any) => {
        upserts.push(args);
        return {};
      },
      findMany: async () => [],
      deleteMany: async (args: any) => {
        deletes.push(args);
        return { count: 0 };
      },
    },
    alertEvent: {
      findMany: async () => [],
      deleteMany: async (args: any) => {
        alertDeletes.push(args);
        return { count: 0 };
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };

  return {
    prisma: db as unknown as PrismaService,
    upserts,
    deletes,
    alertDeletes,
    runQueries: () => runQueries,
  };
}

const lock = (acquired = true): LeaderLock => ({ acquire: async () => acquired });

beforeEach(() => {
  // 固定补算 2 小时，断言不依赖默认的 24 小时。
  process.env.METRICS_BACKFILL_HOURS = '2';
});

afterEach(() => {
  delete process.env.METRICS_BACKFILL_HOURS;
  delete process.env.METRICS_RETENTION_DAYS;
  delete process.env.ALERT_RETENTION_DAYS;
  delete process.env.METRICS_ROLLUP_MS;
  vi.useRealTimers();
});

describe('MetricsSweeper', () => {
  it('重算当前小时之前的两个完整小时并 upsert', async () => {
    const runs: SeedRun[] = [
      {
        id: 'r1',
        tenantId: 't1',
        status: 'done',
        startedAt: new Date('2026-10-20T08:10:00Z'),
        endedAt: new Date('2026-10-20T08:11:00Z'),
      },
      {
        id: 'r2',
        tenantId: 't2',
        status: 'failed',
        startedAt: new Date('2026-10-20T09:10:00Z'),
        endedAt: new Date('2026-10-20T09:12:00Z'),
      },
    ];
    const { prisma, upserts } = makePrisma(runs);
    const sweeper = new MetricsSweeper(prisma, lock());

    await sweeper.tick(NOW);

    const keys = upserts.map(
      (u) =>
        `${String((u.create as any).bucketStart.toISOString())}|${String((u.create as any).metric)}|${String((u.create as any).dimensionType)}|${String((u.create as any).dimensionId)}`,
    );
    expect(keys).toContain('2026-10-20T08:00:00.000Z|runs_started|global|');
    expect(keys).toContain('2026-10-20T08:00:00.000Z|runs_done|tenant|t1');
    expect(keys).toContain('2026-10-20T09:00:00.000Z|runs_failed|global|');
    // 当前小时（10:00）尚未完整，不能入库。
    expect(keys.some((k) => k.startsWith('2026-10-20T10:00:00.000Z'))).toBe(false);
  });

  it('未抢到锁时完全不查库', async () => {
    const { prisma, upserts, runQueries } = makePrisma();
    const sweeper = new MetricsSweeper(prisma, lock(false));
    await sweeper.tick(NOW);
    expect(runQueries()).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it('单轮失败只记指标与日志，不向外抛', async () => {
    const metrics = createBffMetrics({ defaultMetrics: false });
    const broken = {
      run: {
        findMany: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaService;
    const sweeper = new MetricsSweeper(broken, lock(), metrics);

    await expect(sweeper.tick(NOW)).resolves.toBeUndefined();
    expect(await metrics.registry.metrics()).toContain('ai_office_rollup_failures_total 1');
  });

  it('按各自保留天数分 5000 行一批清理过期快照与告警事件', async () => {
    process.env.METRICS_RETENTION_DAYS = '2';
    process.env.ALERT_RETENTION_DAYS = '3';
    const { prisma, deletes, alertDeletes } = makePrisma();
    let bucketBatch = 0;
    let alertBatch = 0;
    (prisma.metricBucket as any).findMany = async () => {
      bucketBatch += 1;
      return bucketBatch === 1
        ? Array.from({ length: 5000 }, (_, i) => ({ id: `b${i}` }))
        : [];
    };
    (prisma.alertEvent as any).findMany = async () => {
      alertBatch += 1;
      return alertBatch === 1
        ? Array.from({ length: 5000 }, (_, i) => ({ id: `e${i}` }))
        : [];
    };
    const sweeper = new MetricsSweeper(prisma, lock());

    await sweeper.purgeRetention(NOW);

    expect(bucketBatch).toBe(2);
    expect(deletes).toHaveLength(1);
    expect((deletes[0].where as any).id.in).toHaveLength(5000);
    expect(((deletes[0].where as any).bucketStart.lt as Date).toISOString()).toBe(
      '2026-10-18T10:35:00.000Z',
    );
    expect(alertBatch).toBe(2);
    expect(alertDeletes).toHaveLength(1);
    expect((alertDeletes[0].where as any).id.in).toHaveLength(5000);
    expect(((alertDeletes[0].where as any).startedAt.lt as Date).toISOString()).toBe(
      '2026-10-17T10:35:00.000Z',
    );
  });

  it('METRICS_ROLLUP_MS=0 时关闭定时任务', () => {
    vi.useFakeTimers();
    process.env.METRICS_ROLLUP_MS = '0';
    const { prisma } = makePrisma();
    const sweeper = new MetricsSweeper(prisma, lock());
    const tick = vi.spyOn(sweeper, 'tick');

    sweeper.onModuleInit();
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(tick).not.toHaveBeenCalled();
    sweeper.onModuleDestroy();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/metrics
```

Expected: FAIL，`./rollup` / `./leader-lock` / `./metrics.sweeper` 不存在。

- [ ] **Step 4: 实现纯聚合**

`apps/bff/src/metrics/rollup.ts`：

```ts
import type { ModelPriceDto } from '@ai-office/shared';
import { boundedLabel } from '@ai-office/telemetry';

export type MetricDimensionType = 'global' | 'model' | 'tenant' | 'tool';

/** 与 Prisma MetricBucket 一一对应；bucketStart 为整点 UTC。 */
export interface MetricBucketInput {
  bucketStart: Date;
  metric: string;
  dimensionType: MetricDimensionType;
  dimensionId: string;
  value: number;
  count: number;
}

export interface RunStartRow {
  tenantId: string;
  startedAt: Date;
}

export interface RunEndRow {
  tenantId: string;
  status: string;
  startedAt: Date;
  endedAt: Date;
}

export interface UsageRollupRow {
  tenantId: string;
  models: unknown;
  inputTokens: number;
  outputTokens: number;
  credits: number | null;
}

export interface ToolStepRow {
  payload: unknown;
}

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

export const HOUR_MS = 3_600_000;

/** 按 UTC 对齐到整点。 */
export function hourStartOf(value: Date): Date {
  const d = new Date(value);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function inHour(value: Date, bucketStart: Date): boolean {
  const ts = value.getTime();
  return ts >= bucketStart.getTime() && ts < bucketStart.getTime() + HOUR_MS;
}

type Acc = Map<string, MetricBucketInput>;

function add(
  acc: Acc,
  bucketStart: Date,
  metric: string,
  dimensionType: MetricDimensionType,
  dimensionId: string,
  value: number,
  count = 0,
): void {
  const key = `${metric} ${dimensionType} ${dimensionId}`;
  const current = acc.get(key);
  if (current) {
    current.value += value;
    current.count += count;
    return;
  }
  acc.set(key, { bucketStart, metric, dimensionType, dimensionId, value, count });
}

/** 固定排序：同一小时重复重算时，写库顺序与结果稳定，便于测试和排障。 */
function finish(acc: Acc): MetricBucketInput[] {
  return [...acc.values()].sort(
    (a, b) =>
      a.metric.localeCompare(b.metric) ||
      a.dimensionType.localeCompare(b.dimensionType) ||
      a.dimensionId.localeCompare(b.dimensionId),
  );
}

export function aggregateRunStarts(
  rows: RunStartRow[],
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    if (!inHour(row.startedAt, bucketStart)) continue;
    add(acc, bucketStart, 'runs_started', 'global', '', 1);
    if (row.tenantId) add(acc, bucketStart, 'runs_started', 'tenant', row.tenantId, 1);
  }
  return finish(acc);
}

export function aggregateRunEnds(
  rows: RunEndRow[],
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    if (!inHour(row.endedAt, bucketStart)) continue;
    if (row.status === 'done') {
      add(acc, bucketStart, 'runs_done', 'global', '', 1);
      if (row.tenantId) add(acc, bucketStart, 'runs_done', 'tenant', row.tenantId, 1);
    } else if (row.status === 'failed') {
      add(acc, bucketStart, 'runs_failed', 'global', '', 1);
      if (row.tenantId) add(acc, bucketStart, 'runs_failed', 'tenant', row.tenantId, 1);
    } else {
      // running 等非终态没有 endedAt 语义，跳过。
      continue;
    }

    // 负时长只可能来自时钟回拨/脏数据，按 0 记，避免快照出现负值。
    const durationMs = Math.max(0, row.endedAt.getTime() - row.startedAt.getTime());
    add(acc, bucketStart, 'run_duration_ms', 'global', '', durationMs, 1);
    if (row.tenantId) {
      add(acc, bucketStart, 'run_duration_ms', 'tenant', row.tenantId, durationMs, 1);
    }
  }
  return finish(acc);
}

export function parseModelUsage(raw: unknown): ModelUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelUsage[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.model !== 'string' || row.model === '') continue;
    const input =
      typeof row.input === 'number' && Number.isFinite(row.input) && row.input > 0
        ? row.input
        : 0;
    const output =
      typeof row.output === 'number' && Number.isFinite(row.output) && row.output > 0
        ? row.output
        : 0;
    if (input === 0 && output === 0) continue;
    out.push({ model: boundedLabel(row.model), input, output });
  }
  return out;
}

/**
 * 把一条用量记录的实际积分按当前价格权重分摊到模型；权重缺失时全部落到
 * 第一个模型，保证分模型积分之和严格等于记录积分。
 */
export function allocateModelCredits(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
  totalCredits: number,
): Array<{ model: string; credits: number }> {
  if (models.length === 0 || totalCredits <= 0) return [];
  const weights = models.map((m) => {
    const price = prices[m.model];
    return price
      ? m.input * price.inputMilliCreditsPer1k + m.output * price.outputMilliCreditsPer1k
      : 0;
  });
  const sum = weights.reduce((acc, item) => acc + item, 0);
  if (sum <= 0) return [{ model: models[0].model, credits: totalCredits }];

  const out: Array<{ model: string; credits: number }> = [];
  let remaining = totalCredits;
  for (let i = 0; i < models.length; i++) {
    const credits =
      i === models.length - 1
        ? remaining
        : Math.min(remaining, Math.floor((totalCredits * weights[i]) / sum));
    remaining -= credits;
    if (credits > 0) out.push({ model: models[i].model, credits });
  }
  return out;
}

export function aggregateUsage(
  rows: UsageRollupRow[],
  prices: Record<string, ModelPriceDto>,
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    add(acc, bucketStart, 'input_tokens', 'global', '', row.inputTokens);
    add(acc, bucketStart, 'output_tokens', 'global', '', row.outputTokens);
    if (row.tenantId) {
      add(acc, bucketStart, 'input_tokens', 'tenant', row.tenantId, row.inputTokens);
      add(acc, bucketStart, 'output_tokens', 'tenant', row.tenantId, row.outputTokens);
    }

    const models = parseModelUsage(row.models);
    for (const model of models) {
      add(acc, bucketStart, 'input_tokens', 'model', model.model, model.input);
      add(acc, bucketStart, 'output_tokens', 'model', model.model, model.output);
    }

    if (row.credits !== null && row.credits > 0) {
      add(acc, bucketStart, 'credits', 'global', '', row.credits);
      if (row.tenantId) add(acc, bucketStart, 'credits', 'tenant', row.tenantId, row.credits);
      for (const item of allocateModelCredits(models, prices, row.credits)) {
        add(acc, bucketStart, 'credits', 'model', item.model, item.credits);
      }
    }
  }
  return finish(acc);
}

export function parseToolResult(payload: unknown): { tool: string; ok: boolean } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.tool !== 'string' || row.tool === '') return null;
  return { tool: boundedLabel(row.tool), ok: row.ok === true };
}

export function aggregateToolCalls(
  rows: ToolStepRow[],
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    const result = parseToolResult(row.payload);
    if (!result) continue;
    add(acc, bucketStart, 'tool_calls', 'tool', result.tool, 1);
    if (!result.ok) add(acc, bucketStart, 'tool_failures', 'tool', result.tool, 1);
  }
  return finish(acc);
}
```

- [ ] **Step 5: 实现 Redis 选主**

`apps/bff/src/metrics/leader-lock.ts`：

```ts
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

export const LEADER_LOCK = Symbol('LEADER_LOCK');
/** Redis 会话锁 TTL：任务正常远短于 55 秒；超时重入由 upsert/openKey 兜底。 */
export const LEADER_TTL_MS = 55_000;

export interface LeaderLock {
  acquire(key: string, ttlMs?: number): Promise<boolean>;
  /** 显式释放连接，避免 useFactory 提供者未触发 Nest 生命周期钩子时进程挂住。 */
  close?(): void;
}

export interface RedisLike {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttl: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  disconnect(): void;
}

export type WarnLogger = Pick<Logger, 'warn'>;

/**
 * Redis SET NX PX 选主。Redis 未配置或暂时不可用时 fail-open：
 * 快照 upsert 天然幂等，告警侧再由 openKey 唯一约束兜底，不能让选主故障阻断采集。
 */
export class RedisLeaderLock implements LeaderLock {
  private readonly logger: WarnLogger;
  private readonly token = randomUUID();

  constructor(
    private readonly redis: RedisLike | null,
    logger: WarnLogger = new Logger(RedisLeaderLock.name),
  ) {
    this.logger = logger;
  }

  async acquire(key: string, ttlMs = LEADER_TTL_MS): Promise<boolean> {
    if (!this.redis) {
      this.logger.warn(`[metrics] REDIS_URL 未配置，${key} 将在每个实例执行`);
      return true;
    }
    try {
      const result = await this.redis.set(key, this.token, 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`[metrics] Redis 选主失败，本轮继续执行: ${(err as Error).message}`);
      return true;
    }
  }

  close(): void {
    this.redis?.disconnect?.();
  }

  /** 由 Nest 在模块销毁时调用；与 close 幂等。 */
  onModuleDestroy(): void {
    this.close();
  }
}

export function createLeaderLock(env: NodeJS.ProcessEnv = process.env): RedisLeaderLock {
  const url = env.REDIS_URL;
  if (!url) return new RedisLeaderLock(null);
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    // 命令级超时：Redis 卡死时选主不能无限挂起，fail-open 才能生效。
    commandTimeout: 2000,
  });
  // ioredis 的 set 重载比 RedisLike 更宽，运行时完全兼容。
  return new RedisLeaderLock(redis as unknown as RedisLike);
}
```

- [ ] **Step 6: 实现快照 sweeper**

`apps/bff/src/metrics/metrics.sweeper.ts`：

```ts
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ModelPriceDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { LEADER_LOCK, type LeaderLock } from './leader-lock';
import {
  aggregateRunEnds,
  aggregateRunStarts,
  aggregateToolCalls,
  aggregateUsage,
  HOUR_MS,
  hourStartOf,
  type RunEndRow,
  type RunStartRow,
  type UsageRollupRow,
} from './rollup';

const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 300_000;
const MIN_INTERVAL_MS = 10_000;
const LEADER_KEY = 'ai-office:metrics:rollup:leader';
const PURGE_BATCH_SIZE = 5000;
const MAX_PURGE_BATCHES = 100;

/** 小时级快照：启动补算 + 每 5 分钟重算最近两个完整小时；每日清理过期数据。 */
@Injectable()
export class MetricsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private backfilled = false;
  private lastPurgeAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEADER_LOCK) private readonly lock: LeaderLock,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  onModuleInit(): void {
    const text = process.env.METRICS_ROLLUP_MS;
    const raw = text === undefined || text.trim() === '' ? DEFAULT_INTERVAL_MS : Number(text);
    // 0 是显式关闭开关，不能退化成默认 5 分钟。
    if (raw === 0) {
      this.logger.warn('[metrics] METRICS_ROLLUP_MS=0，快照任务已关闭');
      return;
    }
    const interval =
      Number.isFinite(raw) && raw > 0 ? Math.max(MIN_INTERVAL_MS, raw) : DEFAULT_INTERVAL_MS;
    if (raw !== interval) {
      this.logger.warn(`[metrics] METRICS_ROLLUP_MS 超出允许范围，已调整为 ${interval}ms`);
    }
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出（测试/短生命周期命令）。
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // 选主 Redis 连接可能由 factory 创建，显式释放，避免关闭后事件循环不退出。
    this.lock.close?.();
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.lock.acquire(LEADER_KEY))) return;

      // 首次执行补算配置的历史窗口；之后每轮只重算最近两个完整小时，
      // 容忍延迟结算，同时避免每分钟扫全表。
      const hours = this.backfilled ? 2 : this.intEnv('METRICS_BACKFILL_HOURS', 24, 1, 168);
      await this.recomputeHours(hours, now);
      this.backfilled = true;

      if (now.getTime() - this.lastPurgeAt >= DAY_MS) {
        this.lastPurgeAt = now.getTime();
        await this.purgeRetention(now);
      }
    } catch (err) {
      this.metrics?.rollupFailures.inc();
      this.logger.error(`[metrics] 快照任务失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** 删除早于保留期的快照与告警事件；各自每批 5000 行，单轮最多 100 批。 */
  async purgeRetention(now = new Date()): Promise<void> {
    const metricCutoff = new Date(
      now.getTime() - this.intEnv('METRICS_RETENTION_DAYS', 90, 1, 3650) * DAY_MS,
    );
    const alertCutoff = new Date(
      now.getTime() - this.intEnv('ALERT_RETENTION_DAYS', 90, 1, 3650) * DAY_MS,
    );
    await this.purgeMetricBuckets(metricCutoff);
    await this.purgeAlertEvents(alertCutoff);
  }

  private async purgeMetricBuckets(cutoff: Date): Promise<void> {
    for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
      const rows = await this.prisma.metricBucket.findMany({
        where: { bucketStart: { lt: cutoff } },
        select: { id: true },
        take: PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) return;
      await this.prisma.metricBucket.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      if (rows.length < PURGE_BATCH_SIZE) return;
    }
    this.logger.warn(
      `[metrics] 单轮快照清理达到上限 ${MAX_PURGE_BATCHES * PURGE_BATCH_SIZE} 行，剩余留待下一轮`,
    );
  }

  private async purgeAlertEvents(cutoff: Date): Promise<void> {
    for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
      const rows = await this.prisma.alertEvent.findMany({
        where: { startedAt: { lt: cutoff } },
        select: { id: true },
        take: PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) return;
      await this.prisma.alertEvent.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      if (rows.length < PURGE_BATCH_SIZE) return;
    }
    this.logger.warn(
      `[metrics] 单轮告警清理达到上限 ${MAX_PURGE_BATCHES * PURGE_BATCH_SIZE} 行，剩余留待下一轮`,
    );
  }

  private async recomputeHours(hours: number, now: Date): Promise<void> {
    const currentHour = hourStartOf(now).getTime();
    for (let offset = hours; offset >= 1; offset--) {
      await this.recomputeHour(new Date(currentHour - offset * HOUR_MS));
    }
  }

  private async recomputeHour(bucketStart: Date): Promise<void> {
    const end = new Date(bucketStart.getTime() + HOUR_MS);
    const [starts, ends, usage, tools, prices] = await Promise.all([
      this.prisma.run.findMany({
        where: { startedAt: { gte: bucketStart, lt: end } },
        select: {
          id: true,
          startedAt: true,
          task: { select: { session: { select: { tenantId: true } } } },
        },
      }),
      this.prisma.run.findMany({
        where: {
          endedAt: { gte: bucketStart, lt: end },
          status: { in: ['done', 'failed'] },
        },
        select: {
          id: true,
          status: true,
          startedAt: true,
          endedAt: true,
          task: { select: { session: { select: { tenantId: true } } } },
        },
      }),
      this.prisma.usageRecord.findMany({
        where: { createdAt: { gte: bucketStart, lt: end } },
        select: {
          tenantId: true,
          models: true,
          inputTokens: true,
          outputTokens: true,
          credits: true,
        },
      }),
      this.prisma.step.findMany({
        where: { ts: { gte: bucketStart, lt: end }, type: 'tool_result' },
        select: { payload: true },
      }),
      this.prisma.modelPrice.findMany({
        select: {
          model: true,
          inputMilliCreditsPer1k: true,
          outputMilliCreditsPer1k: true,
        },
      }),
    ]);

    const startRows: RunStartRow[] = starts.map((row) => ({
      tenantId: row.task.session.tenantId,
      startedAt: row.startedAt,
    }));
    const endRows: RunEndRow[] = [];
    for (const row of ends) {
      if (!row.endedAt) continue;
      endRows.push({
        tenantId: row.task.session.tenantId,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      });
    }
    const usageRows: UsageRollupRow[] = usage.map((row) => ({
      tenantId: row.tenantId,
      models: row.models,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      credits: row.credits,
    }));
    const priceMap: Record<string, ModelPriceDto> = {};
    for (const price of prices) {
      priceMap[price.model] = {
        inputMilliCreditsPer1k: price.inputMilliCreditsPer1k,
        outputMilliCreditsPer1k: price.outputMilliCreditsPer1k,
      };
    }

    const buckets = [
      ...aggregateRunStarts(startRows, bucketStart),
      ...aggregateRunEnds(endRows, bucketStart),
      ...aggregateUsage(usageRows, priceMap, bucketStart),
      ...aggregateToolCalls(tools, bucketStart),
    ];
    if (buckets.length === 0) return;

    await this.prisma.$transaction(
      buckets.map((bucket) =>
        this.prisma.metricBucket.upsert({
          where: {
            bucketStart_metric_dimensionType_dimensionId: {
              bucketStart: bucket.bucketStart,
              metric: bucket.metric,
              dimensionType: bucket.dimensionType,
              dimensionId: bucket.dimensionId,
            },
          },
          create: bucket,
          update: { value: bucket.value, count: bucket.count },
        }),
      ),
    );
  }

  private intEnv(name: string, fallback: number, min: number, max: number): number {
    const text = process.env[name];
    if (text === undefined || text.trim() === '') return fallback;
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }
}
```

- [ ] **Step 7: 实现模块并接入 AppModule**

`apps/bff/src/metrics/metrics.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { LEADER_LOCK, createLeaderLock } from './leader-lock';
import { MetricsSweeper } from './metrics.sweeper';

/** 全局导出选主器，告警模块复用同一条 Redis 连接。 */
@Global()
@Module({
  providers: [
    { provide: LEADER_LOCK, useFactory: () => createLeaderLock() },
    MetricsSweeper,
  ],
  exports: [LEADER_LOCK],
})
export class MetricsModule {}
```

`apps/bff/src/app.module.ts` 的 import 区增加：

```ts
import { MetricsModule } from './metrics/metrics.module';
```

`imports` 改为（保留 Task 2 已加入的 `ObservabilityModule`）：

```ts
  imports: [PrismaModule, ObservabilityModule, MetricsModule, BillingModule, KbModule, ConnectorModule, SettingsModule, AdminModule],
```

- [ ] **Step 8: 跑测试与类型检查**

```bash
pnpm --filter @ai-office/bff test -- src/metrics src/billing
pnpm --filter @ai-office/bff test -- src/admin/admin.endpoints.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 9: 提交**

```bash
git add apps/bff/src/metrics apps/bff/src/app.module.ts
git commit -m "feat(metrics): 小时级指标快照与保留策略

Prometheus 指标随进程重启清零，管理端无法回看趋势。现在每 5 分钟把最近
两个完整小时按 UTC 聚合进 MetricBucket，启动补算 24 小时；多实例用
Redis SET NX 选主，Redis 不可用时 fail-open，靠唯一键 upsert 保证幂等。
过期快照按 5000 行分批清理，避免大表删除长时间锁连接。"
```

---

## Task 9: 告警规则、评估器与 Webhook 投递

**Files:**
- Create: `apps/bff/src/alerts/alert-rules.ts`
- Create: `apps/bff/src/alerts/alert-format.ts`
- Test: `apps/bff/src/alerts/alert-format.test.ts`
- Create: `apps/bff/src/alerts/runtime-summary.client.ts`
- Test: `apps/bff/src/alerts/runtime-summary.client.test.ts`
- Create: `apps/bff/src/alerts/alert-webhook.ts`
- Test: `apps/bff/src/alerts/alert-webhook.test.ts`
- Create: `apps/bff/src/alerts/alert-metrics.ts`
- Test: `apps/bff/src/alerts/alert-metrics.test.ts`
- Create: `apps/bff/src/alerts/alert-evaluator.ts`
- Test: `apps/bff/src/alerts/alert-evaluator.test.ts`
- Create: `apps/bff/src/alerts/alert-sweeper.ts`
- Test: `apps/bff/src/alerts/alert-sweeper.test.ts`
- Create: `apps/bff/src/alerts/alerts.module.ts`
- Modify: `apps/bff/src/app.module.ts`

- [ ] **Step 1: 写失败的规则格式化测试**

`apps/bff/src/alerts/alert-format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { BUILTIN_ALERT_RULES } from './alert-rules';
import { formatAlertMessage, formatResolvedMessage, isBreaching } from './alert-format';

const failureRule = BUILTIN_ALERT_RULES.find((r) => r.key === 'run_failure_rate') as (typeof BUILTIN_ALERT_RULES)[number];
const serviceRule = BUILTIN_ALERT_RULES.find((r) => r.key === 'service_down') as (typeof BUILTIN_ALERT_RULES)[number];

describe('告警格式化', () => {
  it('内置规则覆盖规格中的默认值', () => {
    expect(BUILTIN_ALERT_RULES.map((r) => r.key)).toEqual([
      'service_down',
      'run_failure_rate',
      'model_error_rate',
      'run_latency_p95',
      'billing_settle_failure',
      'credits_spike',
    ]);
    expect(BUILTIN_ALERT_RULES.find((r) => r.key === 'credits_spike')?.enabled).toBe(false);
    expect(
      BUILTIN_ALERT_RULES.find((r) => r.key === 'run_latency_p95'),
    ).toMatchObject({ threshold: 120000, windowMinutes: 15, severity: 'warning' });
  });

  it('按比较符判断越界，非有限数不算越界', () => {
    expect(isBreaching(failureRule, 0.31)).toBe(true);
    expect(isBreaching(failureRule, 0.2)).toBe(false);
    expect(isBreaching(serviceRule, 0)).toBe(true);
    expect(isBreaching(serviceRule, 1)).toBe(false);
    expect(isBreaching(failureRule, Number.NaN)).toBe(false);
  });

  it('消息带窗口、当前值、阈值与方向', () => {
    expect(formatAlertMessage(failureRule, 0.31)).toBe(
      '最近 15 分钟运行失败率为 31%，超过阈值 20%',
    );
    expect(formatAlertMessage(serviceRule, 0)).toBe('最近 2 分钟健康检查未全部通过');
    expect(formatResolvedMessage(failureRule, 0.1)).toBe(
      '最近 15 分钟运行失败率已回落至 10%，阈值 20%',
    );
    expect(formatResolvedMessage(serviceRule, 1)).toBe('最近 2 分钟健康检查已全部通过');
  });
});
```

- [ ] **Step 2: 写失败的 runtime summary 客户端测试**

`apps/bff/src/alerts/runtime-summary.client.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { RuntimeSummaryClient } from './runtime-summary.client';

const summary = {
  status: 'ok' as const,
  windowMinutes: 15,
  activeRuns: 1,
  models: [{ model: 'a', requests: 10, errors: 2, avgLatencyMs: 100 }],
  fallbacks: 0,
  mcpRestarts: 0,
};

describe('RuntimeSummaryClient', () => {
  it('带 token 请求 summary 并解析 JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(summary), { status: 200 }));
    const client = new RuntimeSummaryClient({
      baseUrl: 'http://runtime:4001/',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.fetch(15)).resolves.toEqual(summary);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://runtime:4001/metrics/summary?windowMinutes=15');
    expect((init.headers as Record<string, string>)['x-agent-runtime-token']).toBe('tok');
  });

  it('非 2xx、网络异常都返回 null，不抛错', async () => {
    const notOk = new RuntimeSummaryClient({
      fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(notOk.fetch(15)).resolves.toBeNull();

    const broken = new RuntimeSummaryClient({
      fetchImpl: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    });
    await expect(broken.fetch(15)).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: 写失败的 Webhook 测试**

`apps/bff/src/alerts/alert-webhook.test.ts`：

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_TEST_PAYLOAD_ID,
  buildAlertPayload,
  AlertWebhookNotifier,
  alertDashboardUrl,
} from './alert-webhook';
import { BUILTIN_ALERT_RULES } from './alert-rules';

const rule = BUILTIN_ALERT_RULES.find((r) => r.key === 'run_failure_rate')!;
const event = {
  id: 'e1',
  value: 0.31,
  message: '最近 15 分钟运行失败率为 31%，超过阈值 20%',
  startedAt: new Date('2026-10-20T06:00:00.000Z'),
};
const payload = buildAlertPayload('alert.fired', rule, event, 'https://web.example/admin/alerts');
const target = { url: 'https://hooks.example/alert', secret: 'topsecret', maxPerHour: 60 };
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

describe('AlertWebhookNotifier', () => {
  it('签名并投递，redirect 不跟随', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    const result = await notifier.send(payload, target);
    expect(result).toEqual({
      deliveryStatus: 'sent',
      deliveryError: null,
      notifiedAt: new Date(NOW),
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-ai-office-signature']).toBe(
      `sha256=${createHmac('sha256', 'topsecret').update(init.body as string).digest('hex')}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      version: 1,
      type: 'alert.fired',
      alert: { id: 'e1', ruleKey: 'run_failure_rate', threshold: 0.2 },
    });
  });

  it('未配置 URL 或非 http(s) 时跳过，不发请求', async () => {
    const fetchImpl = vi.fn();
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(notifier.send(payload, { ...target, url: '' })).resolves.toMatchObject({
      deliveryStatus: 'skipped',
      deliveryError: 'webhook_url_empty',
      notifiedAt: null,
    });
    await expect(notifier.send(payload, { ...target, url: 'file:///etc/passwd' })).resolves.toMatchObject({
      deliveryStatus: 'skipped',
      deliveryError: 'invalid_url',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('5xx 重试两次后退避 1s/5s，最终失败', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const sleep = vi.fn(async () => undefined);
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => NOW,
    });

    const result = await notifier.send(payload, target);
    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toBe('http_500');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 5000]);
  });

  it('4xx 不重试；网络异常重试后成功', async () => {
    const bad = vi.fn(async () => new Response('bad', { status: 400 }));
    const noRetry = new AlertWebhookNotifier({
      fetchImpl: bad as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => NOW,
    });
    expect((await noRetry.send(payload, target)).deliveryError).toBe('http_400');
    expect(bad).toHaveBeenCalledTimes(1);

    let calls = 0;
    const flaky = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('econnrefused');
      return new Response('ok', { status: 200 });
    });
    const notifier = new AlertWebhookNotifier({
      fetchImpl: flaky as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => NOW,
    });
    await expect(notifier.send(payload, target)).resolves.toMatchObject({
      deliveryStatus: 'sent',
    });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('每小时配额用尽后只跳过不发送', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await notifier.send(payload, { ...target, maxPerHour: 1 });
    await expect(notifier.send(payload, { ...target, maxPerHour: 1 })).resolves.toMatchObject({
      deliveryStatus: 'skipped',
      deliveryError: 'rate_limited',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('测试告警使用固定 id 且 dashboardUrl 可推导', () => {
    expect(ALERT_TEST_PAYLOAD_ID).toBe('test');
    expect(alertDashboardUrl({ ADMIN_WEB_URL: 'https://office.example/' })).toBe(
      'https://office.example/admin/alerts',
    );
    expect(alertDashboardUrl({})).toBe('http://localhost:3000/admin/alerts');
  });
});
```

- [ ] **Step 4: 写失败的指标读取器测试**

`apps/bff/src/alerts/alert-metrics.test.ts`：

```ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AlertMetricReader } from './alert-metrics';
import type { PrismaService } from '../db/prisma.service';
import type { HealthService } from '../observability/health.service';
import type { RuntimeSummaryProvider } from './runtime-summary.client';

const NOW = new Date('2026-10-20T10:00:00.000Z');

function makeReader(overrides: Record<string, unknown> = {}) {
  const db = {
    run: { groupBy: vi.fn(async () => []) },
    usageRecord: { count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { credits: null } })) },
    $queryRaw: vi.fn(async () => []),
    ...overrides,
  } as unknown as PrismaService;
  const health = { ready: vi.fn(async () => ({ status: 'ready' })) } as unknown as HealthService;
  const runtime: RuntimeSummaryProvider = { fetch: vi.fn(async () => null) };
  return { reader: new AlertMetricReader(db, health, runtime), db, health, runtime };
}

describe('AlertMetricReader', () => {
  it('运行失败率只统计终态 run，无样本返回 null', async () => {
    const { reader, db } = makeReader({
      run: {
        groupBy: async () => [
          { status: 'done', _count: { _all: 3 } },
          { status: 'failed', _count: { _all: 1 } },
        ],
      },
    });
    await expect(reader.read('run_failure_rate', 15, NOW)).resolves.toBeCloseTo(0.25);
    expect((db.run.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      status: { in: ['done', 'failed'] },
    });

    const empty = makeReader();
    await expect(empty.reader.read('run_failure_rate', 15, NOW)).resolves.toBeNull();
  });

  it('P95 用 percentile_cont，窗口内无样本为 null', async () => {
    const { reader } = makeReader({ $queryRaw: async () => [{ p95: 4321.5 }] });
    await expect(reader.read('run_latency_p95_ms', 15, NOW)).resolves.toBe(4321.5);

    const empty = makeReader({ $queryRaw: async () => [{ p95: null }] });
    await expect(empty.reader.read('run_latency_p95_ms', 15, NOW)).resolves.toBeNull();
  });

  it('结算滞留只统计 5 分钟前的 pending', async () => {
    const { reader, db } = makeReader({ usageRecord: { count: async () => 2, aggregate: async () => ({ _sum: { credits: null } }) } });
    await expect(reader.read('billing_settle_failures', 15, NOW)).resolves.toBe(2);
    const where = (db.usageRecord.count as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.status).toBe('pending');
    expect(where.createdAt.lt.toISOString()).toBe('2026-10-20T09:55:00.000Z');
  });

  it('积分总量取已结算记录之和，缺省为 0', async () => {
    const { reader } = makeReader({
      usageRecord: {
        count: async () => 0,
        aggregate: async () => ({ _sum: { credits: 120 } }),
      },
    });
    await expect(reader.read('credits_per_window', 60, NOW)).resolves.toBe(120);

    const empty = makeReader();
    await expect(empty.reader.read('credits_per_window', 60, NOW)).resolves.toBe(0);
  });

  it('模型错误率按请求量加权，数据不足为 null', async () => {
    const { reader, runtime } = makeReader();
    (runtime.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok',
      windowMinutes: 15,
      activeRuns: 0,
      models: [
        { model: 'a', requests: 9, errors: 3, avgLatencyMs: 10 },
        { model: 'b', requests: 1, errors: 0, avgLatencyMs: 10 },
      ],
      fallbacks: 0,
      mcpRestarts: 0,
    });
    await expect(reader.read('model_error_rate', 15, NOW)).resolves.toBeCloseTo(0.3);

    (runtime.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'insufficient_data',
      windowMinutes: 15,
      activeRuns: 0,
      models: [],
      fallbacks: 0,
      mcpRestarts: 0,
    });
    await expect(reader.read('model_error_rate', 15, NOW)).resolves.toBeNull();
  });

  it('服务健康全部通过才算 1，未知指标返回 null', async () => {
    const { reader, health, db } = makeReader();
    await expect(reader.read('service_up', 2, NOW)).resolves.toBe(1);

    (health.ready as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'degraded' });
    await expect(reader.read('service_up', 2, NOW)).resolves.toBe(0);

    await expect(reader.read('not_a_metric', 2, NOW)).resolves.toBeNull();
    expect((db.run.groupBy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 5: 写失败的评估器测试**

`apps/bff/src/alerts/alert-evaluator.test.ts`：

```ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertEvaluator,
  type AlertRuleRow,
  type AlertSettingsProvider,
} from './alert-evaluator';
import type { PrismaService } from '../db/prisma.service';
import type { AlertMetricReader } from './alert-metrics';
import type { AlertWebhookNotifier } from './alert-webhook';
import { createBffMetrics } from '../observability/observability.metrics';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const rule: AlertRuleRow = {
  id: 'r-fail',
  key: 'run_failure_rate',
  name: '运行失败率过高',
  metric: 'run_failure_rate',
  comparator: 'gt',
  threshold: 0.2,
  windowMinutes: 15,
  cooldownMinutes: 15,
  severity: 'warning',
  enabled: true,
};

const settings = (enabled = true): AlertSettingsProvider => ({
  getAlertSettings: async () => ({ enabled, webhookUrl: 'https://hooks.example/a', webhookSecret: 's' }),
});

function makeEnv(opts: { open?: unknown; last?: unknown; value?: number | null; enabled?: boolean } = {}) {
  const created: any[] = [];
  const updates: any[] = [];
  const deliveries: any[] = [];
  const prisma = {
    alertEvent: {
      findUnique: async () => opts.open ?? null,
      findFirst: async () => opts.last ?? null,
      create: async ({ data }: any) => {
        const row = { id: 'e1', ...data };
        created.push(row);
        return row;
      },
      update: async (args: any) => {
        updates.push(args);
        return {};
      },
    },
    // 交互式事务：把同一个 mock 客户端传给回调，模拟 tx。
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaService;
  const reader = {
    read: vi.fn(async () => (opts.value === undefined ? 0.31 : opts.value)),
  } as unknown as AlertMetricReader;
  const notifier = {
    send: async (payload: any, target: any) => {
      deliveries.push({ payload, target });
      return { deliveryStatus: 'sent', deliveryError: null, notifiedAt: NOW };
    },
  } as unknown as AlertWebhookNotifier;
  const metrics = createBffMetrics({ defaultMetrics: false });
  const evaluator = new AlertEvaluator(prisma, reader, settings(opts.enabled), notifier, metrics);
  return { evaluator, prisma, reader, deliveries, created, updates, metrics };
}

describe('AlertEvaluator', () => {
  it('首次越界创建 firing 事件并投递，记录投递结果与触发指标', async () => {
    const env = makeEnv();
    await env.evaluator.evaluate(rule, NOW);

    expect(env.created).toHaveLength(1);
    expect(env.created[0]).toMatchObject({
      ruleId: 'r-fail',
      status: 'firing',
      openKey: 'r-fail',
      value: 0.31,
      message: '最近 15 分钟运行失败率为 31%，超过阈值 20%',
    });
    expect(env.deliveries[0].payload).toMatchObject({
      type: 'alert.fired',
      alert: { ruleKey: 'run_failure_rate', severity: 'warning' },
    });
    expect(env.deliveries[0].target).toEqual({
      url: 'https://hooks.example/a',
      secret: 's',
      maxPerHour: 60,
    });
    expect(env.updates.at(-1)?.data).toMatchObject({ deliveryStatus: 'sent', deliveryError: null });
    expect(await env.metrics.registry.metrics()).toContain('ai_office_alerts_fired_total{severity="warning"} 1');
  });

  it('已有未恢复事件时不重复创建也不通知', async () => {
    const env = makeEnv({ open: { id: 'e1', value: 0.31 } });
    await env.evaluator.evaluate(rule, NOW);
    expect(env.created).toHaveLength(0);
    expect(env.deliveries).toHaveLength(0);
  });

  it('恢复正常时关闭事件并发送 resolved', async () => {
    const env = makeEnv({
      open: { id: 'e1', startedAt: new Date('2026-10-20T09:00:00Z') },
      value: 0.1,
    });
    await env.evaluator.evaluate(rule, NOW);

    expect(env.updates[0].data).toMatchObject({
      status: 'resolved',
      resolvedAt: NOW,
      openKey: null,
      value: 0.1,
    });
    expect(env.deliveries[0].payload.type).toBe('alert.resolved');
    expect(env.deliveries[0].payload.alert).toMatchObject({
      id: 'e1',
      startedAt: '2026-10-20T09:00:00.000Z',
    });
  });

  it('冷却期内不创建新事件', async () => {
    const env = makeEnv({ last: { startedAt: new Date(NOW.getTime() - 5 * 60_000) } });
    await env.evaluator.evaluate(rule, NOW);
    expect(env.created).toHaveLength(0);
    expect(env.deliveries).toHaveLength(0);
  });

  it('唯一冲突说明他实例已建，跳过投递', async () => {
    const env = makeEnv();
    (env.prisma.alertEvent as any).create = async () => {
      throw Object.assign(new Error('duplicate'), { code: 'P2002' });
    };
    await env.evaluator.evaluate(rule, NOW);
    expect(env.deliveries).toHaveLength(0);
  });

  it('告警总开关关闭时不读取指标', async () => {
    const env = makeEnv({ enabled: false });
    await env.evaluator.evaluate(rule, NOW);
    expect((env.reader.read as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(env.created).toHaveLength(0);
  });

  it('指标数据不足时保持现状', async () => {
    const env = makeEnv({ open: { id: 'e1' }, value: null });
    await env.evaluator.evaluate(rule, NOW);
    expect(env.updates).toHaveLength(0);
    expect(env.deliveries).toHaveLength(0);
  });
});
```

- [ ] **Step 6: 写失败的 sweeper 测试**

`apps/bff/src/alerts/alert-sweeper.test.ts`：

```ts
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertSweeper } from './alert-sweeper';
import { BUILTIN_ALERT_RULES } from './alert-rules';
import type { PrismaService } from '../db/prisma.service';
import type { LeaderLock } from '../metrics/leader-lock';
import type { AlertEvaluator } from './alert-evaluator';
import { createBffMetrics } from '../observability/observability.metrics';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const lock = (acquired = true): LeaderLock => ({ acquire: async () => acquired });

function makeSweeper(rules: any[], acquired = true) {
  const evaluated: string[] = [];
  const seeds: any[] = [];
  const prisma = {
    alertRule: {
      createMany: async (args: any) => {
        seeds.push(args);
        return { count: 0 };
      },
      findMany: async () => rules,
    },
  } as unknown as PrismaService;
  const evaluator = {
    evaluate: async (rule: any) => {
      evaluated.push(rule.key);
      if (rule.key === 'bad') throw new Error('evaluate failed');
    },
  } as unknown as AlertEvaluator;
  const metrics = createBffMetrics({ defaultMetrics: false });
  return {
    sweeper: new AlertSweeper(prisma, lock(acquired), evaluator, metrics),
    evaluated,
    seeds,
    metrics,
  };
}

afterEach(() => {
  delete process.env.ALERT_EVAL_MS;
});

describe('AlertSweeper', () => {
  it('幂等写入内置规则且不改动已有规则', async () => {
    const { sweeper, seeds } = makeSweeper([]);
    await sweeper.seed();
    expect(seeds).toHaveLength(1);
    expect(seeds[0].skipDuplicates).toBe(true);
    expect(seeds[0].data.map((r: any) => r.key)).toEqual(
      BUILTIN_ALERT_RULES.map((r) => r.key),
    );
  });

  it('未抢到锁时跳过评估', async () => {
    const { sweeper, evaluated } = makeSweeper([], false);
    await sweeper.tick(NOW);
    expect(evaluated).toHaveLength(0);
  });

  it('逐条评估启用规则，单条失败不影响后续并计入失败指标', async () => {
    const { sweeper, evaluated, metrics } = makeSweeper([
      { key: 'bad' },
      { key: 'run_failure_rate' },
    ]);
    await sweeper.tick(NOW);
    expect(evaluated).toEqual(['bad', 'run_failure_rate']);
    expect(await metrics.registry.metrics()).toContain(
      'ai_office_alert_eval_failures_total 1',
    );
  });

  it('首次 tick 前先补齐规则', async () => {
    const { sweeper, seeds } = makeSweeper([]);
    await sweeper.tick(NOW);
    expect(seeds).toHaveLength(1);
  });

  it('tick 内并发保护：上一轮未结束时直接返回', async () => {
    const { sweeper, evaluated } = makeSweeper([{ key: 'run_failure_rate' }]);
    await Promise.all([sweeper.tick(NOW), sweeper.tick(NOW)]);
    expect(evaluated).toHaveLength(1);
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/alerts
```

Expected: FAIL，`./alert-format` 等模块不存在。

- [ ] **Step 8: 实现规则与格式化**

`apps/bff/src/alerts/alert-rules.ts`：

```ts
export type AlertComparator = 'gt' | 'lt';
export type AlertSeverity = 'warning' | 'critical';

export interface AlertRuleSeed {
  key: string;
  name: string;
  metric: string;
  comparator: AlertComparator;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: AlertSeverity;
  enabled: boolean;
}

/**
 * 内置规则按 key 幂等插入；已存在的规则不覆盖，保留管理员调整。
 * credits_spike 默认关闭：不同业务规模的安全阈值差异过大，需管理员显式设定。
 */
export const BUILTIN_ALERT_RULES: readonly AlertRuleSeed[] = [
  {
    key: 'service_down',
    name: '服务不可用',
    metric: 'service_up',
    comparator: 'lt',
    threshold: 1,
    windowMinutes: 2,
    cooldownMinutes: 5,
    severity: 'critical',
    enabled: true,
  },
  {
    key: 'run_failure_rate',
    name: '运行失败率过高',
    metric: 'run_failure_rate',
    comparator: 'gt',
    threshold: 0.2,
    windowMinutes: 15,
    cooldownMinutes: 15,
    severity: 'warning',
    enabled: true,
  },
  {
    key: 'model_error_rate',
    name: '模型错误率过高',
    metric: 'model_error_rate',
    comparator: 'gt',
    threshold: 0.2,
    windowMinutes: 15,
    cooldownMinutes: 15,
    severity: 'warning',
    enabled: true,
  },
  {
    key: 'run_latency_p95',
    name: '运行 P95 耗时过高',
    metric: 'run_latency_p95_ms',
    comparator: 'gt',
    threshold: 120000,
    windowMinutes: 15,
    cooldownMinutes: 15,
    severity: 'warning',
    enabled: true,
  },
  {
    key: 'billing_settle_failure',
    name: '计费结算滞留',
    metric: 'billing_settle_failures',
    comparator: 'gt',
    threshold: 0,
    windowMinutes: 15,
    cooldownMinutes: 30,
    severity: 'critical',
    enabled: true,
  },
  {
    key: 'credits_spike',
    name: '积分消耗突增',
    metric: 'credits_per_window',
    comparator: 'gt',
    threshold: 100000,
    windowMinutes: 60,
    cooldownMinutes: 60,
    severity: 'warning',
    enabled: false,
  },
];
```

`apps/bff/src/alerts/alert-format.ts`：

```ts
export interface AlertRuleLike {
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowMinutes: number;
}

const METRIC_LABELS: Record<string, string> = {
  service_up: '服务健康状态',
  run_failure_rate: '运行失败率',
  model_error_rate: '模型错误率',
  run_latency_p95_ms: '运行 P95 耗时',
  billing_settle_failures: '结算滞留数',
  credits_per_window: '积分消耗',
};

const METRIC_FORMATTERS: Record<string, (value: number) => string> = {
  service_up: (value) => (value >= 1 ? '正常' : '异常'),
  run_failure_rate: (value) => `${(value * 100).toFixed(0)}%`,
  model_error_rate: (value) => `${(value * 100).toFixed(0)}%`,
  run_latency_p95_ms: (value) => `${Math.round(value)}ms`,
  billing_settle_failures: (value) => `${Math.round(value)} 条`,
  credits_per_window: (value) => `${Math.round(value)} 积分`,
};

export function formatMetricValue(metric: string, value: number): string {
  return (METRIC_FORMATTERS[metric] ?? ((v: number) => String(v)))(value);
}

export function isBreaching(rule: AlertRuleLike, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return rule.comparator === 'lt'
    ? value < rule.threshold
    : value > rule.threshold;
}

export function formatAlertMessage(rule: AlertRuleLike, value: number): string {
  if (rule.metric === 'service_up') {
    return `最近 ${rule.windowMinutes} 分钟健康检查未全部通过`;
  }
  const label = METRIC_LABELS[rule.metric] ?? rule.metric;
  const direction = rule.comparator === 'lt' ? '低于' : '超过';
  return (
    `最近 ${rule.windowMinutes} 分钟${label}为 ${formatMetricValue(rule.metric, value)}，` +
    `${direction}阈值 ${formatMetricValue(rule.metric, rule.threshold)}`
  );
}

export function formatResolvedMessage(rule: AlertRuleLike, value: number): string {
  if (rule.metric === 'service_up') {
    return `最近 ${rule.windowMinutes} 分钟健康检查已全部通过`;
  }
  const label = METRIC_LABELS[rule.metric] ?? rule.metric;
  return (
    `最近 ${rule.windowMinutes} 分钟${label}已回落至 ${formatMetricValue(rule.metric, value)}，` +
    `阈值 ${formatMetricValue(rule.metric, rule.threshold)}`
  );
}
```

- [ ] **Step 9: 实现 runtime summary 客户端与 Webhook 投递**

`apps/bff/src/alerts/runtime-summary.client.ts`：

```ts
import type { RuntimeSummaryDto } from '@ai-office/shared';

export const RUNTIME_SUMMARY = Symbol('RUNTIME_SUMMARY');

export interface RuntimeSummaryProvider {
  fetch(windowMinutes: number): Promise<RuntimeSummaryDto | null>;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** runtime `/metrics/summary` 客户端；失败返回 null，由调用方视为数据不足。 */
export class RuntimeSummaryClient implements RuntimeSummaryProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    options: {
      baseUrl?: string;
      token?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
    this.token = options.token ?? process.env.AGENT_RUNTIME_TOKEN ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetch(windowMinutes: number): Promise<RuntimeSummaryDto | null> {
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/metrics/summary?windowMinutes=${windowMinutes}`,
        {
          headers: this.token ? { 'x-agent-runtime-token': this.token } : {},
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok) return null;
      return (await res.json()) as RuntimeSummaryDto;
    } catch {
      return null;
    }
  }
}
```

`apps/bff/src/alerts/alert-webhook.ts`：

```ts
import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';

export type AlertWebhookType = 'alert.fired' | 'alert.resolved' | 'alert.test';

export interface AlertWebhookPayload {
  version: 1;
  type: AlertWebhookType;
  alert: {
    id: string;
    ruleKey: string;
    ruleName: string;
    severity: 'warning' | 'critical';
    value: number;
    threshold: number;
    message: string;
    startedAt: string;
  };
  dashboardUrl: string;
}

export interface AlertDelivery {
  deliveryStatus: 'sent' | 'failed' | 'skipped';
  deliveryError: string | null;
  notifiedAt: Date | null;
}

export interface WebhookTarget {
  url: string;
  secret: string;
  maxPerHour: number;
}

export interface AlertRulePayloadSource {
  key: string;
  name: string;
  severity: string;
  threshold: number;
}

export interface AlertEventPayloadSource {
  id: string;
  value: number;
  message: string;
  startedAt: Date;
}

export const ALERT_TEST_PAYLOAD_ID = 'test';

const RETRY_DELAYS_MS = [1000, 5000, 15000];
const REQUEST_TIMEOUT_MS = 5000;
const RATE_WINDOW_MS = 3_600_000;
const MAX_ERROR_LENGTH = 200;
const DEFAULT_MAX_PER_HOUR = 60;

/** 滚动一小时发送配额；非法配置回退默认值，避免 0 值静默关闭全部告警。 */
export function alertMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ALERT_MAX_PER_HOUR ?? DEFAULT_MAX_PER_HOUR);
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(10_000, raw) : DEFAULT_MAX_PER_HOUR;
}

export function alertTarget(config: {
  webhookUrl: string;
  webhookSecret: string;
}): WebhookTarget {
  return { url: config.webhookUrl, secret: config.webhookSecret, maxPerHour: alertMaxPerHour() };
}

export function alertDashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.ADMIN_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/admin/alerts`;
}

export function buildAlertPayload(
  type: AlertWebhookType,
  rule: AlertRulePayloadSource,
  event: AlertEventPayloadSource,
  dashboardUrl: string,
): AlertWebhookPayload {
  return {
    version: 1,
    type,
    alert: {
      id: event.id,
      ruleKey: rule.key,
      ruleName: rule.name,
      severity: rule.severity === 'critical' ? 'critical' : 'warning',
      value: event.value,
      threshold: rule.threshold,
      message: event.message,
      startedAt: event.startedAt.toISOString(),
    },
    dashboardUrl,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function signAlertPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

type WarnLogger = Pick<Logger, 'warn'>;

/**
 * Webhook 投递：5 秒超时、不跟随重定向、仅 http(s)、HMAC 签名、最多 3 次。
 * 4xx（429 除外）重试无意义，直接失败；4xx/5xx/网络错误都在这里收敛为投递结果，
 * 不让告警评估因外部端点故障而中断。
 */
export class AlertWebhookNotifier {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: WarnLogger;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  private readonly sentAt: number[] = [];

  constructor(
    options: {
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      logger?: WarnLogger;
      retryDelaysMs?: number[];
      timeoutMs?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? new Logger(AlertWebhookNotifier.name);
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async send(payload: AlertWebhookPayload, target: WebhookTarget): Promise<AlertDelivery> {
    if (!target.url) return this.skipped('webhook_url_empty');
    if (!isHttpUrl(target.url)) return this.skipped('invalid_url');
    if (!this.takeQuota(target.maxPerHour)) {
      this.logger.warn('[alerts] Webhook 每小时配额已用尽，本条仅记录事件');
      return this.skipped('rate_limited');
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (target.secret) headers['x-ai-office-signature'] = signAlertPayload(body, target.secret);

    let error = 'unknown_error';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        const res = await this.fetchImpl(target.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          return { deliveryStatus: 'sent', deliveryError: null, notifiedAt: new Date(this.now()) };
        }
        error = `http_${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        error = (err as Error).message || 'fetch_failed';
      }
      const delay = this.retryDelaysMs[attempt];
      if (delay !== undefined) await this.sleep(delay);
    }

    const deliveryError = error.slice(0, MAX_ERROR_LENGTH);
    this.logger.warn(`[alerts] Webhook 投递失败: ${deliveryError}`);
    return { deliveryStatus: 'failed', deliveryError, notifiedAt: new Date(this.now()) };
  }

  /** 滚动 1 小时配额；重试消耗的是同一条通知，不重复计数。 */
  private takeQuota(maxPerHour: number): boolean {
    const now = this.now();
    while (this.sentAt.length > 0 && now - (this.sentAt[0] as number) >= RATE_WINDOW_MS) {
      this.sentAt.shift();
    }
    if (this.sentAt.length >= maxPerHour) return false;
    this.sentAt.push(now);
    return true;
  }

  private skipped(error: string): AlertDelivery {
    return { deliveryStatus: 'skipped', deliveryError: error, notifiedAt: null };
  }
}
```

- [ ] **Step 10: 实现指标读取器**

`apps/bff/src/alerts/alert-metrics.ts`：

```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { HealthService } from '../observability/health.service';
import { RUNTIME_SUMMARY, type RuntimeSummaryProvider } from './runtime-summary.client';

const SETTLE_STUCK_MS = 5 * 60_000;
const RUNTIME_MAX_WINDOW_MINUTES = 60;

interface CountRow {
  status: string;
  _count: { _all: number };
}

interface P95Row {
  p95: number | null;
}

/** 按规则指标读取窗口值；无足够样本时返回 null，评估器据此跳过状态变更。 */
@Injectable()
export class AlertMetricReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
    @Optional()
    @Inject(RUNTIME_SUMMARY)
    private readonly runtime?: RuntimeSummaryProvider,
  ) {}

  async read(metric: string, windowMinutes: number, now = new Date()): Promise<number | null> {
    const from = new Date(now.getTime() - windowMinutes * 60_000);
    switch (metric) {
      case 'service_up':
        return this.serviceUp();
      case 'run_failure_rate':
        return this.failureRate(from, now);
      case 'model_error_rate':
        return this.modelErrorRate(windowMinutes);
      case 'run_latency_p95_ms':
        return this.latencyP95(from, now);
      case 'billing_settle_failures':
        return this.stuckSettlements(from, now);
      case 'credits_per_window':
        return this.credits(from, now);
      default:
        return null;
    }
  }

  private async serviceUp(): Promise<number> {
    const ready = await this.health.ready();
    return ready.status === 'ready' ? 1 : 0;
  }

  private async failureRate(from: Date, now: Date): Promise<number | null> {
    const rows = (await this.prisma.run.groupBy({
      by: ['status'],
      where: {
        endedAt: { gte: from, lt: now },
        status: { in: ['done', 'failed'] },
      },
      _count: { _all: true },
    })) as unknown as CountRow[];

    let done = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === 'failed') failed += row._count._all;
      else if (row.status === 'done') done += row._count._all;
    }
    const total = done + failed;
    return total === 0 ? null : failed / total;
  }

  private async modelErrorRate(windowMinutes: number): Promise<number | null> {
    if (!this.runtime) return null;
    // runtime summary 自身限制在 1–60 分钟；更长窗口由规则层避免使用该指标。
    const summary = await this.runtime.fetch(
      Math.min(RUNTIME_MAX_WINDOW_MINUTES, Math.max(1, windowMinutes)),
    );
    if (!summary || summary.status !== 'ok') return null;
    let requests = 0;
    let errors = 0;
    for (const model of summary.models) {
      requests += model.requests;
      errors += model.errors;
    }
    return requests === 0 ? null : errors / requests;
  }

  private async latencyP95(from: Date, now: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<P95Row[]>`
      SELECT percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) * 1000
      )::float8 AS p95
      FROM "Run"
      WHERE "endedAt" >= ${from} AND "endedAt" < ${now}
        AND "status" IN ('done', 'failed')
    `;
    const value = rows[0]?.p95;
    return value === null || value === undefined ? null : Number(value);
  }

  private async stuckSettlements(from: Date, now: Date): Promise<number> {
    return this.prisma.usageRecord.count({
      where: {
        status: 'pending',
        createdAt: { gte: from, lt: new Date(now.getTime() - SETTLE_STUCK_MS) },
      },
    });
  }

  private async credits(from: Date, now: Date): Promise<number> {
    const agg = await this.prisma.usageRecord.aggregate({
      where: { status: 'settled', createdAt: { gte: from, lt: now } },
      _sum: { credits: true },
    });
    return agg._sum.credits ?? 0;
  }
}
```

> `billing_settle_failures` 用 DB 查询而不是 Prometheus 计数器：计数器按进程累计且随重启清零，跨实例也不可加；DB 口径才能在多实例下准确驱动告警。

- [ ] **Step 11: 实现评估器**

`apps/bff/src/alerts/alert-evaluator.ts`：

```ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../db/prisma.service';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { AlertMetricReader } from './alert-metrics';
import { isBreaching, formatAlertMessage, formatResolvedMessage } from './alert-format';
import {
  AlertWebhookNotifier,
  alertDashboardUrl,
  alertTarget,
  buildAlertPayload,
  type AlertDelivery,
} from './alert-webhook';

export interface AlertRuleRow {
  id: string;
  key: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: string;
  enabled: boolean;
}

export interface AlertSettingsProvider {
  getAlertSettings(): Promise<{
    enabled: boolean;
    webhookUrl: string;
    webhookSecret: string;
  }>;
}

interface OpenEvent {
  id: string;
  startedAt: Date;
}

interface CreatedEvent {
  id: string;
  startedAt: Date;
  value: number;
  message: string;
}

/**
 * 单条规则的状态机：
 * 越界且无 open 事件 → 创建 firing（唯一键冲突说明他实例已建）→ 通知；
 * 持续越界 → 保持首次值不变、不重复通知；
 * 恢复 → 关闭 open 事件并通知 resolved。
 */
@Injectable()
export class AlertEvaluator {
  private readonly logger = new Logger(AlertEvaluator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AlertMetricReader,
    @Inject(SettingsService) private readonly settings: AlertSettingsProvider,
    private readonly notifier: AlertWebhookNotifier,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  async evaluate(rule: AlertRuleRow, now = new Date()): Promise<void> {
    const config = await this.settings.getAlertSettings();
    if (!config.enabled) return;

    const value = await this.reader.read(rule.metric, rule.windowMinutes, now);
    if (value === null || !Number.isFinite(value)) return;

    const open = (await this.prisma.alertEvent.findUnique({
      where: { openKey: rule.id },
    })) as OpenEvent | null;

    if (isBreaching(rule, value)) {
      if (open) return;
      const last = await this.prisma.alertEvent.findFirst({
        where: { ruleId: rule.id },
        orderBy: { startedAt: 'desc' },
      });
      if (
        last &&
        now.getTime() - last.startedAt.getTime() < rule.cooldownMinutes * 60_000
      ) {
        this.logger.warn(`[alerts] 规则 ${rule.key} 仍在冷却期，跳过通知`);
        return;
      }
      await this.fire(rule, value, now, config);
      return;
    }

    if (open) await this.resolve(rule, open, value, now, config);
  }

  private async fire(
    rule: AlertRuleRow,
    value: number,
    now: Date,
    config: Awaited<ReturnType<AlertSettingsProvider['getAlertSettings']>>,
  ): Promise<void> {
    const message = formatAlertMessage(rule, value);
    let event: CreatedEvent;
    try {
      event = await this.prisma.$transaction(async (tx) =>
        tx.alertEvent.create({
          data: {
            ruleId: rule.id,
            ruleName: rule.name,
            status: 'firing',
            value,
            message,
            startedAt: now,
            // openKey 唯一：数据库层保证每条规则最多一个未恢复事件。
            openKey: rule.id,
          },
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return;
      throw err;
    }

    this.metrics?.alertsFired.inc({ severity: rule.severity });
    const delivery = await this.notifier.send(
      buildAlertPayload('alert.fired', rule, event, alertDashboardUrl()),
      alertTarget(config),
    );
    await this.applyDelivery(event.id, delivery);
  }

  private async resolve(
    rule: AlertRuleRow,
    open: OpenEvent,
    value: number,
    now: Date,
    config: Awaited<ReturnType<AlertSettingsProvider['getAlertSettings']>>,
  ): Promise<void> {
    const message = formatResolvedMessage(rule, value);
    await this.prisma.alertEvent.update({
      where: { id: open.id },
      data: {
        status: 'resolved',
        resolvedAt: now,
        value,
        message,
        // 置空后才能允许下一次触发；PostgreSQL 唯一索引允许多个 NULL。
        openKey: null,
      },
    });

    const delivery = await this.notifier.send(
      buildAlertPayload(
        'alert.resolved',
        rule,
        { id: open.id, value, message, startedAt: open.startedAt },
        alertDashboardUrl(),
      ),
      alertTarget(config),
    );
    await this.applyDelivery(open.id, delivery);
  }

  private async applyDelivery(id: string, delivery: AlertDelivery): Promise<void> {
    await this.prisma.alertEvent.update({
      where: { id },
      data: {
        deliveryStatus: delivery.deliveryStatus,
        deliveryError: delivery.deliveryError,
        notifiedAt: delivery.notifiedAt,
      },
    });
  }

}
```

- [ ] **Step 12: 实现 sweeper 与模块**

`apps/bff/src/alerts/alert-sweeper.ts`：

```ts
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { LEADER_LOCK, type LeaderLock } from '../metrics/leader-lock';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { BUILTIN_ALERT_RULES } from './alert-rules';
import { AlertEvaluator, type AlertRuleRow } from './alert-evaluator';

const LEADER_KEY = 'ai-office:alerts:eval:leader';
const DEFAULT_EVAL_MS = 60_000;
const MIN_EVAL_MS = 5_000;

/** 每 60 秒评估启用规则；Redis 选主，单条规则失败不影响其余规则。 */
@Injectable()
export class AlertSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private seeded = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEADER_LOCK) private readonly lock: LeaderLock,
    private readonly evaluator: AlertEvaluator,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  onModuleInit(): void {
    // 规则播种与评估频率无关：即使关闭评估，管理端也要能看到内置规则。
    void this.seed().catch((err: Error) => {
      this.logger.error(`[alerts] 内置规则写入失败: ${err.message}`);
    });

    const text = process.env.ALERT_EVAL_MS;
    const raw = text === undefined || text.trim() === '' ? DEFAULT_EVAL_MS : Number(text);
    if (raw === 0) {
      this.logger.warn('[alerts] ALERT_EVAL_MS=0，告警评估已关闭');
      return;
    }
    const interval =
      Number.isFinite(raw) && raw > 0 ? Math.max(MIN_EVAL_MS, raw) : DEFAULT_EVAL_MS;
    if (raw !== interval) {
      this.logger.warn(`[alerts] ALERT_EVAL_MS 超出允许范围，已调整为 ${interval}ms`);
    }
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 按 key 幂等补齐内置规则；已存在的不覆盖，保留管理员调整。 */
  async seed(): Promise<void> {
    await this.prisma.alertRule.createMany({
      data: BUILTIN_ALERT_RULES.map((rule) => ({ ...rule })),
      skipDuplicates: true,
    });
    this.seeded = true;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.lock.acquire(LEADER_KEY))) return;
      if (!this.seeded) await this.seed();

      const rules = (await this.prisma.alertRule.findMany({
        where: { enabled: true },
      })) as unknown as AlertRuleRow[];

      for (const rule of rules) {
        try {
          await this.evaluator.evaluate(rule, now);
        } catch (err) {
          this.metrics?.alertEvalFailures.inc();
          this.logger.error(`[alerts] 规则 ${rule.key} 评估失败: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.metrics?.alertEvalFailures.inc();
      this.logger.error(`[alerts] 评估轮次失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
```

`apps/bff/src/alerts/alerts.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AlertEvaluator } from './alert-evaluator';
import { AlertMetricReader } from './alert-metrics';
import { AlertSweeper } from './alert-sweeper';
import { AlertWebhookNotifier } from './alert-webhook';
import { RUNTIME_SUMMARY, RuntimeSummaryClient } from './runtime-summary.client';

/** 告警引擎：指标读取、规则评估、Webhook 投递；管理端复用投递器与载荷构造。 */
@Module({
  imports: [SettingsModule],
  providers: [
    { provide: RUNTIME_SUMMARY, useFactory: () => new RuntimeSummaryClient() },
    AlertMetricReader,
    AlertWebhookNotifier,
    AlertEvaluator,
    AlertSweeper,
  ],
  exports: [AlertMetricReader, AlertWebhookNotifier, AlertEvaluator],
})
export class AlertsModule {}
```

`apps/bff/src/app.module.ts` 的 import 区增加：

```ts
import { AlertsModule } from './alerts/alerts.module';
```

`imports` 改为：

```ts
  imports: [
    PrismaModule,
    ObservabilityModule,
    MetricsModule,
    BillingModule,
    KbModule,
    ConnectorModule,
    SettingsModule,
    AlertsModule,
    AdminModule,
  ],
```

- [ ] **Step 13: 跑测试与类型检查**

```bash
pnpm --filter @ai-office/bff test -- src/alerts src/metrics
pnpm --filter @ai-office/bff typecheck
```

Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 14: 提交**

```bash
git add apps/bff/src/alerts apps/bff/src/app.module.ts
git commit -m "feat(alerts): 内置告警规则与 Webhook 投递

指标只有被持续观察才有意义。现在按规格内置六条规则，启动时按 key 幂等
写入；评估器每分钟在 Redis 选主后读取 DB/runtime 实测值，越界时以唯一
openKey 建立 firing 事件并投递签名 Webhook，恢复后自动关闭。告警关闭或
指标样本不足时不做状态变更，避免误报和误恢复。"
```

---

## Task 10: 概览、指标序列、告警管理与运行时间线 API

**Files:**
- Create: `apps/bff/src/admin/run-timeline.ts`
- Test: `apps/bff/src/admin/run-timeline.test.ts`
- Create: `apps/bff/src/admin/admin-observability.service.ts`
- Create: `apps/bff/src/admin/admin-observability.controller.ts`
- Test: `apps/bff/src/admin/admin-observability.service.test.ts`
- Create: `apps/bff/src/admin/admin-alerts.service.ts`
- Create: `apps/bff/src/admin/admin-alerts.controller.ts`
- Test: `apps/bff/src/admin/admin-alerts.service.test.ts`
- Modify: `apps/bff/src/admin/admin-tasks.service.ts`
- Modify: `apps/bff/src/admin/admin-tasks.controller.ts`
- Modify: `apps/bff/src/admin/admin-tasks.service.test.ts`
- Modify: `apps/bff/src/admin/admin.module.ts`
- Modify: `apps/bff/src/admin/admin.endpoints.test.ts`

- [ ] **Step 1: 写失败的时间线聚合测试**

`apps/bff/src/admin/run-timeline.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildTimelineNodes, type TimelineRun, type TimelineStep } from './run-timeline';

const run: TimelineRun = {
  id: 'r1',
  status: 'done',
  startedAt: new Date('2026-10-01T00:00:00Z'),
  endedAt: new Date('2026-10-01T00:01:00Z'),
};

function step(
  id: string,
  seq: number,
  type: string,
  payload: unknown,
  second: number,
): TimelineStep {
  return { id, seq, type, payload, ts: new Date(`2026-10-01T00:00:${String(second).padStart(2, '0')}Z`) };
}

const steps: TimelineStep[] = [
  step('s1', 0, 'think', { text: '敏感思考正文' }, 1),
  step('s2', 1, 'tool_call', { tool: 'web.search', input: { q: '敏感入参' } }, 2),
  step('s3', 2, 'confirm_request', { tool: 'web.search' }, 3),
  step('s4', 3, 'tool_result', { tool: 'web.search', ok: true, preview: '敏感结果' }, 4),
  step('s5', 4, 'tool_call', { tool: 'shell.exec', input: '敏感命令' }, 5),
  step('s6', 5, 'tool_result', { tool: 'shell.exec', ok: false, reason: 'user_denied' }, 6),
  step('s7', 6, 'tool_call', { tool: 'http.get' }, 7),
  step('s8', 7, 'tool_result', { tool: 'http.get', ok: false, error: '敏感错误' }, 8),
  step('s9', 8, 'artifact', { kind: 'file', filename: 'report.xlsx', storageKey: 'k', size: 10 }, 9),
  step('s10', 9, 'notice', { code: 'budget_exceeded', text: '敏感提示' }, 9),
];

describe('buildTimelineNodes', () => {
  it('按阶段聚合节点并只保留安全标签', () => {
    const { nodes, truncated } = buildTimelineNodes(run, steps);
    expect(nodes.map((n) => n.kind)).toEqual([
      'accepted',
      'think',
      'tool',
      'confirm',
      'tool',
      'tool',
      'artifact',
      'notice',
      'finished',
    ]);
    expect(nodes[0]).toMatchObject({
      label: '已受理',
      status: 'ok',
      startedAt: '2026-10-01T00:00:00.000Z',
      endedAt: '2026-10-01T00:00:01.000Z',
      durationMs: 1000,
    });
    expect(nodes[1]).toMatchObject({ label: '模型思考', durationMs: 1000 });
    expect(nodes[2]).toMatchObject({
      label: 'web.search',
      status: 'ok',
      startedAt: '2026-10-01T00:00:02.000Z',
      endedAt: '2026-10-01T00:00:04.000Z',
      durationMs: 2000,
    });
    expect(nodes[3]).toMatchObject({
      label: '等待确认：web.search',
      status: 'done',
      durationMs: 1000,
    });
    expect(nodes[4]).toMatchObject({ label: 'shell.exec', status: 'denied' });
    expect(nodes[5]).toMatchObject({ label: 'http.get', status: 'failed' });
    expect(nodes[6]).toMatchObject({
      label: 'report.xlsx',
      status: 'ok',
      startedAt: '2026-10-01T00:00:09.000Z',
    });
    expect(nodes[7]).toMatchObject({ label: '预算超限', status: 'failed' });
    expect(nodes[8]).toMatchObject({ kind: 'finished', status: 'ok' });
    expect(truncated).toBe(false);

    // 时间线会暴露给管理端与页面，不能带出 prompt/入参/结果正文。
    const dump = JSON.stringify(nodes);
    expect(dump).not.toContain('敏感');
    expect(dump).not.toContain('storageKey');
  });

  it('运行中的未完成工具与结束节点标记 running', () => {
    const running: TimelineRun = { ...run, status: 'running', endedAt: null };
    const pending = [step('t1', 0, 'tool_call', { tool: 'web.search' }, 1)];
    const { nodes } = buildTimelineNodes(running, pending);
    expect(nodes[1]).toMatchObject({ kind: 'tool', status: 'running', endedAt: null });
    expect(nodes[2]).toMatchObject({ kind: 'finished', status: 'running', endedAt: null });
  });

  it('step 被截断时追加省略节点并标记 truncated', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      step(`m${i}`, i, 'think', {}, 1),
    );
    const { nodes, truncated } = buildTimelineNodes(run, many, 700);
    expect(truncated).toBe(true);
    expect(nodes.length).toBeLessThanOrEqual(500);
    expect(nodes[nodes.length - 1].kind).toBe('notice');
    expect(nodes[nodes.length - 1].label).toMatch(/^其余 \d+ 个节点已省略$/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/admin/run-timeline.test.ts
```

Expected: FAIL，`Cannot find module './run-timeline'`。

- [ ] **Step 3: 实现时间线纯函数**

`apps/bff/src/admin/run-timeline.ts`：

```ts
import type {
  AdminTimelineNodeDto,
  AdminTimelineNodeKind,
  AdminTimelineNodeStatus,
} from '@ai-office/shared';

/** 一次运行最多抓取/展示的 step 数；溢出节点保证总节点数不超过 500。 */
export const TIMELINE_STEP_LIMIT = 500;
const NODE_LIMIT = 500;
const TOOL_LABEL_LIMIT = 64;
const FILE_LABEL_LIMIT = 100;

export interface TimelineRun {
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface TimelineStep {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: Date;
}

export interface TimelineBuildResult {
  nodes: AdminTimelineNodeDto[];
  truncated: boolean;
}

function payloadOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 按码点截断，避免切裂 emoji；绝不回传入参/结果正文。 */
function labelOf(value: unknown, fallback: string, limit: number): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return Array.from(value).slice(0, limit).join('');
}

function toolName(step: TimelineStep): string {
  return labelOf(payloadOf(step.payload).tool, '工具', TOOL_LABEL_LIMIT);
}

function resultStatus(payload: unknown): AdminTimelineNodeStatus {
  const value = payloadOf(payload);
  if (value.ok === true) return 'ok';
  if (value.reason === 'user_denied') return 'denied';
  return 'failed';
}

function makeNode(
  id: string,
  kind: AdminTimelineNodeKind,
  label: string,
  status: AdminTimelineNodeStatus,
  startedAt: Date,
  endedAt: Date | null,
): AdminTimelineNodeDto {
  return {
    id,
    kind,
    label,
    status,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
    durationMs: endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
  };
}

/**
 * 把 step 事件聚合成阶段时间线：
 * tool_call 与下一条同名 tool_result 配对；confirm_request 等待的是下一条 tool_result。
 * 标签只允许工具名、文件名与静态文案，避免把 prompt/入参/结果带进管理端。
 */
export function buildTimelineNodes(
  run: TimelineRun,
  steps: TimelineStep[],
  totalSteps = steps.length,
): TimelineBuildResult {
  const nodes: AdminTimelineNodeDto[] = [];
  const firstTs = steps[0]?.ts ?? run.endedAt;
  nodes.push(
    makeNode(
      `${run.id}:accepted`,
      'accepted',
      '已受理',
      run.status === 'running' ? 'running' : 'ok',
      run.startedAt,
      firstTs,
    ),
  );

  const consumed = new Set<number>();

  for (let i = 0; i < steps.length; i++) {
    if (consumed.has(i)) continue;
    const current = steps[i];
    const nextTs = steps[i + 1]?.ts ?? run.endedAt;

    switch (current.type) {
      case 'think': {
        const status: AdminTimelineNodeStatus = nextTs
          ? 'done'
          : run.status === 'running'
            ? 'running'
            : 'done';
        nodes.push(makeNode(current.id, 'think', '模型思考', status, current.ts, nextTs ?? null));
        break;
      }
      case 'tool_call': {
        const tool = toolName(current);
        const resultIndex = steps.findIndex(
          (candidate, index) =>
            index > i && candidate.type === 'tool_result' && toolName(candidate) === tool,
        );
        const result = resultIndex >= 0 ? steps[resultIndex] : undefined;
        if (resultIndex >= 0) consumed.add(resultIndex);
        const status: AdminTimelineNodeStatus = result
          ? resultStatus(result.payload)
          : run.status === 'running'
            ? 'running'
            : 'failed';
        nodes.push(makeNode(current.id, 'tool', tool, status, current.ts, result?.ts ?? null));
        break;
      }
      case 'tool_result': {
        // 未被 tool_call 配对的孤立结果也要展示，避免时间线断档。
        nodes.push(
          makeNode(
            current.id,
            'tool',
            toolName(current),
            resultStatus(current.payload),
            current.ts,
            null,
          ),
        );
        break;
      }
      case 'confirm_request': {
        const answer = steps.slice(i + 1).find((candidate) => candidate.type === 'tool_result');
        const status: AdminTimelineNodeStatus = answer
          ? 'done'
          : run.status === 'running'
            ? 'blocked'
            : 'failed';
        nodes.push(
          makeNode(
            current.id,
            'confirm',
            `等待确认：${toolName(current)}`,
            status,
            current.ts,
            answer?.ts ?? null,
          ),
        );
        break;
      }
      case 'artifact': {
        const label = labelOf(payloadOf(current.payload).filename, '成果文件', FILE_LABEL_LIMIT);
        nodes.push(makeNode(current.id, 'artifact', label, 'ok', current.ts, null));
        break;
      }
      case 'notice': {
        const budget = payloadOf(current.payload).code === 'budget_exceeded';
        nodes.push(
          makeNode(
            current.id,
            'notice',
            budget ? '预算超限' : '系统提示',
            budget ? 'failed' : 'done',
            current.ts,
            null,
          ),
        );
        break;
      }
      default:
        // 未知事件可能携带自由文本，宁可不展示也不冒险泄露。
        break;
    }
  }

  const finishFrom = steps[steps.length - 1]?.ts ?? run.startedAt;
  if (run.endedAt) {
    const failed = run.status === 'failed';
    nodes.push(
      makeNode(
        `${run.id}:finished`,
        'finished',
        failed ? '运行失败' : '运行结束',
        failed ? 'failed' : 'ok',
        finishFrom,
        run.endedAt,
      ),
    );
  } else {
    nodes.push(
      makeNode(`${run.id}:finished`, 'finished', '运行中', 'running', finishFrom, null),
    );
  }

  const omittedSteps = Math.max(0, totalSteps - steps.length);
  const truncated = omittedSteps > 0 || nodes.length > NODE_LIMIT;
  if (!truncated) return { nodes, truncated: false };

  const keep = Math.min(nodes.length, NODE_LIMIT - 1);
  const kept = nodes.slice(0, keep);
  const anchor = kept[kept.length - 1];
  const omittedNodes = omittedSteps + (nodes.length - kept.length);
  kept.push({
    id: `${run.id}:overflow`,
    kind: 'notice',
    label: `其余 ${omittedNodes} 个节点已省略`,
    status: 'done',
    startedAt: anchor?.endedAt ?? anchor?.startedAt ?? run.startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
  });
  return { nodes: kept, truncated: true };
}
```

- [ ] **Step 4: 运行时间线测试确认通过**

```bash
pnpm --filter @ai-office/bff test -- src/admin/run-timeline.test.ts
```

Expected: 3 条 PASS。

- [ ] **Step 5: 写失败的概览与指标序列测试**

`apps/bff/src/admin/admin-observability.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AdminObservabilityService } from './admin-observability.service';
import type { PrismaService } from '../db/prisma.service';
import type { HealthService } from '../observability/health.service';

interface BucketSeed {
  bucketStart: Date;
  metric: string;
  value: number;
  count?: number;
  dimensionType?: string;
  dimensionId?: string;
}

interface ServiceSeed {
  buckets?: BucketSeed[];
  firing?: number;
  p95?: Record<string, number | null>;
}

function makeService(seed: ServiceSeed = {}) {
  const buckets = seed.buckets ?? [];
  const calls: Array<{ where?: any }> = [];

  const prisma = {
    metricBucket: {
      findMany: async (args: { where?: any }) => {
        calls.push(args);
        const where = args.where ?? {};
        return buckets
          .filter((bucket) => {
            if (bucket.bucketStart < where.bucketStart.gte) return false;
            if (bucket.bucketStart >= where.bucketStart.lt) return false;
            if (where.metric?.in && !where.metric.in.includes(bucket.metric)) return false;
            if (where.dimensionType && (bucket.dimensionType ?? 'global') !== where.dimensionType) {
              return false;
            }
            if (where.dimensionId !== undefined && (bucket.dimensionId ?? '') !== where.dimensionId) {
              return false;
            }
            return true;
          })
          .map((bucket) => ({
            bucketStart: bucket.bucketStart,
            metric: bucket.metric,
            value: bucket.value,
            count: bucket.count ?? 0,
            dimensionId: bucket.dimensionId ?? '',
          }));
      },
    },
    alertEvent: {
      count: async () => seed.firing ?? 0,
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const from = values[0] as Date;
      return [{ p95: seed.p95?.[from.toISOString()] ?? null }];
    },
  } as unknown as PrismaService;

  const health = {
    ready: async () => ({
      status: 'ready',
      version: 'test',
      checks: {
        db: { ok: true, latencyMs: 1 },
        redis: { ok: true, skipped: true },
        runtime: { ok: true, latencyMs: 2 },
      },
    }),
  } as unknown as HealthService;

  return { svc: new AdminObservabilityService(prisma, health), calls };
}

const highVolume: BucketSeed[] = [
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'runs_started', value: 3 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'runs_done', value: 2 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'runs_failed', value: 1 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'run_duration_ms', value: 3000, count: 3 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'input_tokens', value: 100 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'output_tokens', value: 50 },
  { bucketStart: new Date('2026-10-20T10:00:00Z'), metric: 'credits', value: 7 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'runs_started', value: 2 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'runs_done', value: 2 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'input_tokens', value: 40 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'output_tokens', value: 20 },
  { bucketStart: new Date('2026-10-20T11:00:00Z'), metric: 'credits', value: 3 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'runs_started', value: 10 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'runs_done', value: 9 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'runs_failed', value: 1 },
  { bucketStart: new Date('2026-10-19T00:00:00Z'), metric: 'credits', value: 20 },
  {
    bucketStart: new Date('2026-10-20T10:00:00Z'),
    metric: 'credits',
    dimensionType: 'model',
    dimensionId: 'model-a',
    value: 6,
  },
  {
    bucketStart: new Date('2026-10-20T10:00:00Z'),
    metric: 'credits',
    dimensionType: 'model',
    dimensionId: 'model-b',
    value: 4,
  },
  {
    bucketStart: new Date('2026-10-18T10:00:00Z'),
    metric: 'credits',
    dimensionType: 'model',
    dimensionId: 'model-a',
    value: 99,
  },
];

const now = new Date('2026-10-20T12:34:00Z');

describe('AdminObservabilityService', () => {
  it('24h 概览汇总当前/上一周期、补零序列、模型成本与健康状态', async () => {
    const { svc } = makeService({
      buckets: highVolume,
      firing: 2,
      p95: {
        '2026-10-19T13:00:00.000Z': 320,
        '2026-10-18T13:00:00.000Z': 410,
      },
    });
    const dto = await svc.overview({ range: '24h' }, now);

    expect(dto.range).toBe('24h');
    expect(dto.current).toEqual({
      runs: 5,
      failedRuns: 1,
      successRate: 0.8,
      inputTokens: 140,
      outputTokens: 70,
      credits: 10,
      avgDurationMs: 1000,
      p95DurationMs: 320,
      unresolvedAlerts: 2,
    });
    expect(dto.previous).toMatchObject({
      runs: 10,
      failedRuns: 1,
      successRate: 0.9,
      credits: 20,
      avgDurationMs: null,
      p95DurationMs: 410,
      unresolvedAlerts: 2,
    });
    expect(dto.series).toHaveLength(24);
    expect(dto.series[0].bucketStart).toBe('2026-10-19T13:00:00.000Z');
    expect(dto.series[21]).toMatchObject({ runs: 3, failedRuns: 1, credits: 7, avgDurationMs: 1000 });
    expect(dto.series[22]).toMatchObject({ runs: 2, failedRuns: 0, credits: 3, avgDurationMs: null });
    expect(dto.series[20]).toMatchObject({ runs: 0, failedRuns: 0, credits: 0 });
    expect(dto.modelCosts).toEqual([
      { model: 'model-a', credits: 6 },
      { model: 'model-b', credits: 4 },
    ]);
    expect(dto.serviceHealth).toEqual([
      { name: 'db', up: true, checkedAt: '2026-10-20T12:34:00.000Z' },
      { name: 'redis', up: true, checkedAt: '2026-10-20T12:34:00.000Z' },
      { name: 'runtime', up: true, checkedAt: '2026-10-20T12:34:00.000Z' },
    ]);
    expect(dto.generatedAt).toBe('2026-10-20T12:34:00.000Z');
  });

  it('7d 按 UTC 天聚合，序列首尾与窗口对齐', async () => {
    const { svc } = makeService({
      buckets: [
        { bucketStart: new Date('2026-10-18T05:00:00Z'), metric: 'runs_started', value: 2 },
        { bucketStart: new Date('2026-10-18T06:00:00Z'), metric: 'runs_started', value: 3 },
      ],
    });
    const dto = await svc.overview({ range: '7d' }, now);
    expect(dto.series).toHaveLength(7);
    expect(dto.series[0].bucketStart).toBe('2026-10-14T00:00:00.000Z');
    expect(dto.series[6].bucketStart).toBe('2026-10-20T00:00:00.000Z');
    expect(dto.series[4]).toMatchObject({ bucketStart: '2026-10-18T00:00:00.000Z', runs: 5 });
  });

  it('非法 range 抛 400', async () => {
    const { svc } = makeService();
    await expect(svc.overview({ range: '1y' }, now)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('timeseries 按天聚合、缺桶补 0 并回显范围', async () => {
    const { svc } = makeService({
      buckets: [
        { bucketStart: new Date('2026-10-18T05:00:00Z'), metric: 'runs_started', value: 2 },
        { bucketStart: new Date('2026-10-19T05:00:00Z'), metric: 'credits', value: 4 },
      ],
    });
    const dto = await svc.timeseries({
      metrics: 'runs_started,credits',
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-20T00:00:00Z',
      granularity: 'day',
    });
    expect(dto).toMatchObject({
      from: '2026-10-18T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
      granularity: 'day',
    });
    expect(dto.series.map((s) => s.metric)).toEqual(['runs_started', 'credits']);
    expect(dto.series[0].points.map((p) => p.value)).toEqual([2, 0]);
    expect(dto.series[1].points.map((p) => p.value)).toEqual([0, 4]);
    expect(dto.series[0].points[0].bucketStart).toBe('2026-10-18T00:00:00.000Z');
  });

  it('timeseries 按维度过滤', async () => {
    const { svc, calls } = makeService();
    await svc.timeseries({
      metrics: 'credits',
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-20T00:00:00Z',
      dimensionType: 'model',
      dimensionId: 'model-a',
    });
    expect(calls[0].where).toMatchObject({
      dimensionType: 'model',
      dimensionId: 'model-a',
      metric: { in: ['credits'] },
    });
  });

  it('timeseries 未指定维度时按维度拆分，尾部合并为 other', async () => {
    const buckets: BucketSeed[] = Array.from({ length: 10 }, (_, index) => ({
      bucketStart: new Date('2026-10-18T05:00:00Z'),
      metric: 'credits',
      dimensionType: 'model',
      dimensionId: `m${index}`,
      value: index + 1,
    }));
    const { svc } = makeService({ buckets });
    const dto = await svc.timeseries({
      metrics: 'credits',
      from: '2026-10-18T00:00:00Z',
      to: '2026-10-19T00:00:00Z',
      granularity: 'day',
      dimensionType: 'model',
    });
    expect(dto.series.map((s) => s.dimensionId)).toEqual([
      'm9',
      'm8',
      'm7',
      'm6',
      'm5',
      'm4',
      'm3',
      'other',
    ]);
    expect(dto.series[7].points[0].value).toBe(1 + 2 + 3);
  });

  it('timeseries 校验 metric 数量、范围与枚举', async () => {
    const { svc } = makeService();
    const base = { from: '2026-10-18T00:00:00Z', to: '2026-10-20T00:00:00Z' };
    await expect(
      svc.timeseries({ ...base, metrics: 'runs,credits,runs_started,runs_done,runs_failed' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.timeseries({ ...base, metrics: 'secret_metric' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.timeseries({
        metrics: 'credits',
        from: '2026-01-01T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.timeseries({ metrics: 'credits', from: base.to, to: base.from }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.timeseries({ ...base, metrics: 'credits', granularity: 'minute' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.timeseries({ ...base, metrics: 'credits', dimensionType: 'user' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/admin/admin-observability.service.test.ts
```

Expected: FAIL，`Cannot find module './admin-observability.service'`。

- [ ] **Step 7: 实现概览服务与控制器**

`apps/bff/src/admin/admin-observability.service.ts`：

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AdminMetricDimensionType,
  AdminMetricGranularity,
  AdminMetricSeriesDto,
  AdminMetricTimeseriesDto,
  AdminOverviewDto,
  AdminOverviewKpiDto,
  AdminOverviewPointDto,
  AdminOverviewRange,
  AdminServiceHealthDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { HealthService } from '../observability/health.service';
import { optionalDate, optionalString } from './admin.util';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_RANGE_MS = 90 * DAY_MS;
const MAX_TIMESERIES_METRICS = 4;
const MAX_TIMESERIES_DIMENSIONS = 8;
const MAX_MODEL_COSTS = 20;

const RANGE_HOURS: Record<AdminOverviewRange, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const OVERVIEW_METRICS = [
  'runs_started',
  'runs_done',
  'runs_failed',
  'run_duration_ms',
  'input_tokens',
  'output_tokens',
  'credits',
] as const;

const TIMESERIES_METRICS = new Set<string>([
  ...OVERVIEW_METRICS,
  'tool_calls',
  'tool_failures',
]);

const DIMENSION_TYPES: AdminMetricDimensionType[] = ['global', 'model', 'tenant', 'tool'];

interface BucketValue {
  value: number;
  count: number;
}

type BucketMap = Map<number, Map<string, BucketValue>>;

function parseRange(raw: unknown): AdminOverviewRange {
  if (raw === undefined || raw === null || raw === '') return '24h';
  if (raw === '24h' || raw === '7d' || raw === '30d') return raw;
  throw new BadRequestException('invalid_range');
}

function startOfHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function startOfUtcDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function bucketStartOf(date: Date, granularity: AdminMetricGranularity): Date {
  return granularity === 'hour' ? startOfHour(date) : startOfUtcDay(date);
}

function bucketStepMs(granularity: AdminMetricGranularity): number {
  return granularity === 'hour' ? HOUR_MS : DAY_MS;
}

function parseGranularity(raw: unknown): AdminMetricGranularity {
  if (raw === undefined || raw === null || raw === '') return 'hour';
  if (raw === 'hour' || raw === 'day') return raw;
  throw new BadRequestException('invalid_granularity');
}

function parseDimensionType(raw: unknown): AdminMetricDimensionType {
  if (raw === undefined || raw === null || raw === '') return 'global';
  if (typeof raw === 'string' && (DIMENSION_TYPES as string[]).includes(raw)) {
    return raw as AdminMetricDimensionType;
  }
  throw new BadRequestException('invalid_dimension_type');
}

function parseMetrics(raw: unknown): string[] {
  const value = optionalString(raw);
  if (!value) throw new BadRequestException('invalid_metrics');
  const metrics = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (metrics.length === 0 || metrics.length > MAX_TIMESERIES_METRICS) {
    throw new BadRequestException('invalid_metrics');
  }
  if (metrics.some((metric) => !TIMESERIES_METRICS.has(metric))) {
    throw new BadRequestException('invalid_metrics');
  }
  return metrics;
}

@Injectable()
export class AdminObservabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
  ) {}

  async overview(query: Record<string, unknown>, now = new Date()): Promise<AdminOverviewDto> {
    const range = parseRange(query.range);
    const hours = RANGE_HOURS[range];
    const stepMs = range === '24h' ? HOUR_MS : DAY_MS;
    const currentStart = range === '24h' ? startOfHour(now) : startOfUtcDay(now);
    const end = new Date(currentStart.getTime() + stepMs);
    const start = new Date(end.getTime() - hours * HOUR_MS);
    const previousStart = new Date(start.getTime() - hours * HOUR_MS);

    const [currentBuckets, previousBuckets, currentP95, previousP95, unresolvedAlerts] =
      await Promise.all([
        this.readBuckets(start, end),
        this.readBuckets(previousStart, start),
        this.p95(start, end),
        this.p95(previousStart, start),
        this.prisma.alertEvent.count({ where: { status: 'firing' } }),
      ]);

    const [modelCosts, serviceHealth] = await Promise.all([
      this.modelCosts(start, end),
      this.serviceHealth(now),
    ]);

    return {
      range,
      current: this.kpi(currentBuckets, start, end, currentP95, unresolvedAlerts),
      previous: this.kpi(previousBuckets, previousStart, start, previousP95, unresolvedAlerts),
      series: this.buildSeries(currentBuckets, start, end, stepMs),
      modelCosts,
      serviceHealth,
      generatedAt: now.toISOString(),
    };
  }

  async timeseries(query: Record<string, unknown>): Promise<AdminMetricTimeseriesDto> {
    const metrics = parseMetrics(query.metrics);
    const from = optionalDate(query.from, 'invalid_range');
    const to = optionalDate(query.to, 'invalid_range');
    if (!from || !to || from.getTime() >= to.getTime()) {
      throw new BadRequestException('invalid_range');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('range_too_large');
    }
    const granularity = parseGranularity(query.granularity);
    const dimensionType = parseDimensionType(query.dimensionType);
    const dimensionId = optionalString(query.dimensionId) ?? '';

    const stepMs = bucketStepMs(granularity);
    const first = bucketStartOf(from, granularity);
    const end = this.seriesEnd(to, granularity);

    const rows = await this.prisma.metricBucket.findMany({
      where: {
        metric: { in: metrics },
        dimensionType,
        ...(dimensionId ? { dimensionId } : {}),
        bucketStart: { gte: first, lt: end },
      },
      select: { bucketStart: true, metric: true, dimensionId: true, value: true, count: true },
    });

    // 未指定具体维度时按维度拆分（供按模型堆叠）；维度过多时尾部合并到 other。
    const dimensions = this.seriesDimensions(rows, dimensionType, dimensionId);
    const kept = new Set(dimensions);
    const dimensionOf = (id: string) => (kept.has(id) ? id : 'other');

    const values = new Map<string, BucketValue>();
    for (const row of rows) {
      const key = `${dimensionOf(row.dimensionId)}:${row.bucketStart.getTime()}:${row.metric}`;
      const previous = values.get(key) ?? { value: 0, count: 0 };
      values.set(key, {
        value: previous.value + row.value,
        count: previous.count + row.count,
      });
    }

    const series: AdminMetricSeriesDto[] = [];
    for (const metric of metrics) {
      for (const dim of dimensions) {
        const points = [];
        for (let t = first.getTime(); t < end.getTime(); t += stepMs) {
          let value = 0;
          let count = 0;
          const bucketEnd = Math.min(t + stepMs, end.getTime());
          for (let h = t; h < bucketEnd; h += HOUR_MS) {
            const bucket = values.get(`${dim}:${h}:${metric}`);
            if (bucket) {
              value += bucket.value;
              count += bucket.count;
            }
          }
          points.push({ bucketStart: new Date(t).toISOString(), value, count });
        }
        series.push({ metric, dimensionType, dimensionId: dim, points });
      }
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      series,
    };
  }

  /**
   * 请求了具体维度就只返回它；否则按总价值降序取前 8 个，尾部归入 other，
   * 既支持按模型堆叠，也避免租户维度把响应撑爆。global 固定单序列。
   */
  private seriesDimensions(
    rows: Array<{ dimensionId: string; value: number }>,
    dimensionType: AdminMetricDimensionType,
    requested: string,
  ): string[] {
    if (dimensionType === 'global') return [''];
    if (requested) return [requested];
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.dimensionId, (totals.get(row.dimensionId) ?? 0) + row.value);
    }
    const ids = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    if (ids.length <= MAX_TIMESERIES_DIMENSIONS) return ids;
    return [...ids.slice(0, MAX_TIMESERIES_DIMENSIONS - 1), 'other'];
  }

  /** 对齐到桶边界；to 恰好落在边界时按右开区间处理，避免多出一个整桶。 */
  private seriesEnd(to: Date, granularity: AdminMetricGranularity): Date {
    const aligned = bucketStartOf(to, granularity);
    return aligned.getTime() === to.getTime()
      ? aligned
      : new Date(aligned.getTime() + bucketStepMs(granularity));
  }

  private async readBuckets(from: Date, to: Date): Promise<BucketMap> {
    const rows = await this.prisma.metricBucket.findMany({
      where: {
        dimensionType: 'global',
        dimensionId: '',
        metric: { in: [...OVERVIEW_METRICS] },
        bucketStart: { gte: from, lt: to },
      },
      select: { bucketStart: true, metric: true, value: true, count: true },
    });

    const map: BucketMap = new Map();
    for (const row of rows) {
      const key = row.bucketStart.getTime();
      let metrics = map.get(key);
      if (!metrics) {
        metrics = new Map();
        map.set(key, metrics);
      }
      const previous = metrics.get(row.metric) ?? { value: 0, count: 0 };
      metrics.set(row.metric, {
        value: previous.value + row.value,
        count: previous.count + row.count,
      });
    }
    return map;
  }

  private sumWindow(
    buckets: BucketMap,
    metric: string,
    from: Date,
    to: Date,
    field: 'value' | 'count',
  ): number {
    let total = 0;
    for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
      total += buckets.get(t)?.get(metric)?.[field] ?? 0;
    }
    return total;
  }

  private kpi(
    buckets: BucketMap,
    from: Date,
    to: Date,
    p95: number | null,
    unresolvedAlerts: number,
  ): AdminOverviewKpiDto {
    const done = this.sumWindow(buckets, 'runs_done', from, to, 'value');
    const failed = this.sumWindow(buckets, 'runs_failed', from, to, 'value');
    const durationValue = this.sumWindow(buckets, 'run_duration_ms', from, to, 'value');
    const durationCount = this.sumWindow(buckets, 'run_duration_ms', from, to, 'count');
    return {
      runs: this.sumWindow(buckets, 'runs_started', from, to, 'value'),
      failedRuns: failed,
      successRate: done + failed === 0 ? null : done / (done + failed),
      inputTokens: this.sumWindow(buckets, 'input_tokens', from, to, 'value'),
      outputTokens: this.sumWindow(buckets, 'output_tokens', from, to, 'value'),
      credits: this.sumWindow(buckets, 'credits', from, to, 'value'),
      avgDurationMs: durationCount === 0 ? null : Math.round(durationValue / durationCount),
      p95DurationMs: p95,
      unresolvedAlerts,
    };
  }

  private buildSeries(
    buckets: BucketMap,
    start: Date,
    end: Date,
    stepMs: number,
  ): AdminOverviewPointDto[] {
    const points: AdminOverviewPointDto[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
      const bucketStart = new Date(t);
      const bucketEnd = new Date(Math.min(t + stepMs, end.getTime()));
      const durationValue = this.sumWindow(buckets, 'run_duration_ms', bucketStart, bucketEnd, 'value');
      const durationCount = this.sumWindow(buckets, 'run_duration_ms', bucketStart, bucketEnd, 'count');
      points.push({
        bucketStart: bucketStart.toISOString(),
        runs: this.sumWindow(buckets, 'runs_started', bucketStart, bucketEnd, 'value'),
        failedRuns: this.sumWindow(buckets, 'runs_failed', bucketStart, bucketEnd, 'value'),
        inputTokens: this.sumWindow(buckets, 'input_tokens', bucketStart, bucketEnd, 'value'),
        outputTokens: this.sumWindow(buckets, 'output_tokens', bucketStart, bucketEnd, 'value'),
        credits: this.sumWindow(buckets, 'credits', bucketStart, bucketEnd, 'value'),
        avgDurationMs: durationCount === 0 ? null : Math.round(durationValue / durationCount),
      });
    }
    return points;
  }

  private async modelCosts(
    from: Date,
    to: Date,
  ): Promise<Array<{ model: string; credits: number }>> {
    const rows = await this.prisma.metricBucket.findMany({
      where: {
        dimensionType: 'model',
        metric: 'credits',
        bucketStart: { gte: from, lt: to },
      },
      select: { dimensionId: true, value: true },
    });

    const totals = new Map<string, number>();
    for (const row of rows) {
      const model = row.dimensionId || 'unknown';
      totals.set(model, (totals.get(model) ?? 0) + row.value);
    }
    return [...totals.entries()]
      .map(([model, credits]) => ({ model, credits }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, MAX_MODEL_COSTS);
  }

  private async serviceHealth(now: Date): Promise<AdminServiceHealthDto[]> {
    const names = ['db', 'redis', 'runtime'] as const;
    const checkedAt = now.toISOString();
    try {
      const ready = await this.health.ready();
      return names.map((name) => ({ name, up: ready.checks[name].ok, checkedAt }));
    } catch {
      // 概览不能因为健康探测异常而整体失败。
      return names.map((name) => ({ name, up: false, checkedAt }));
    }
  }

  private async p95(from: Date, to: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ p95: number | null }>>`
      SELECT percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) * 1000
      )::float8 AS p95
      FROM "Run"
      WHERE "status" IN ('done', 'failed')
        AND "endedAt" >= ${from}
        AND "endedAt" < ${to}
    `;
    const value = rows[0]?.p95;
    return value === null || value === undefined ? null : Math.round(Number(value));
  }
}
```

`apps/bff/src/admin/admin-observability.controller.ts`：

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminMetricTimeseriesDto, AdminOverviewDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AdminObservabilityService } from './admin-observability.service';

/** 管理端概览与指标序列：跨租户聚合数据，统一要求管理员角色。 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminObservabilityController {
  constructor(private readonly observability: AdminObservabilityService) {}

  @Get('overview')
  overview(@Query() query: Record<string, unknown>): Promise<AdminOverviewDto> {
    return this.observability.overview(query ?? {});
  }

  @Get('metrics/timeseries')
  timeseries(@Query() query: Record<string, unknown>): Promise<AdminMetricTimeseriesDto> {
    return this.observability.timeseries(query ?? {});
  }
}
```

- [ ] **Step 8: 运行概览测试确认通过**

```bash
pnpm --filter @ai-office/bff test -- src/admin/admin-observability.service.test.ts
```

Expected: 7 条 PASS。

- [ ] **Step 9: 写失败的告警管理测试**

`apps/bff/src/admin/admin-alerts.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAlertsService } from './admin-alerts.service';
import type { PrismaService } from '../db/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { SettingsService } from '../settings/settings.service';
import type { AlertWebhookNotifier, AlertDelivery } from '../alerts/alert-webhook';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

const ruleRow = {
  id: 'rule1',
  key: 'run_failure_rate',
  name: '运行失败率',
  metric: 'run_failure_rate',
  comparator: 'gt',
  threshold: 0.5,
  windowMinutes: 15,
  cooldownMinutes: 30,
  severity: 'warning',
  enabled: true,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
};

const events = [
  {
    id: 'e1',
    ruleId: 'rule1',
    ruleName: '运行失败率',
    status: 'firing',
    value: 0.8,
    message: '运行失败率 0.8 超过阈值 0.5',
    startedAt: new Date('2026-10-20T00:00:00Z'),
    resolvedAt: null,
    notifiedAt: new Date('2026-10-20T00:00:05Z'),
    deliveryStatus: 'sent',
    deliveryError: null,
  },
  {
    id: 'e2',
    ruleId: 'rule1',
    ruleName: '运行失败率',
    status: 'resolved',
    value: 0.2,
    message: '运行失败率 0.2 已恢复',
    startedAt: new Date('2026-10-19T00:00:00Z'),
    resolvedAt: new Date('2026-10-19T01:00:00Z'),
    notifiedAt: null,
    deliveryStatus: 'skipped',
    deliveryError: 'rule_disabled',
  },
];

function makeService(options: { sendResult?: AlertDelivery } = {}) {
  const rules = [{ ...ruleRow }];
  const updateManyCalls: any[] = [];
  const auditWrites: unknown[] = [];
  const auditBestEffort: unknown[] = [];
  const sent: Array<{ payload: any; target: any }> = [];

  const matchEvent = (event: (typeof events)[number], where: any) => {
    if (where?.status && event.status !== where.status) return false;
    const range = where?.startedAt;
    if (range?.gte && event.startedAt.getTime() < range.gte.getTime()) return false;
    if (range?.lte && event.startedAt.getTime() > range.lte.getTime()) return false;
    return true;
  };

  const prisma: any = {
    alertRule: {
      findMany: async () => rules,
      findUnique: async ({ where }: any) => rules.find((rule) => rule.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const rule = rules.find((item) => item.id === where.id);
        if (!rule) throw new Error('missing rule');
        Object.assign(rule, data, { updatedAt: new Date('2026-10-20T00:00:00Z') });
        return { ...rule };
      },
    },
    alertEvent: {
      count: async ({ where }: any) => events.filter((event) => matchEvent(event, where)).length,
      findMany: async ({ where, skip = 0, take = events.length }: any) =>
        events
          .filter((event) => matchEvent(event, where))
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(skip, skip + take),
      updateMany: async (args: any) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
    },
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      auditWrites.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      auditBestEffort.push(entry);
    },
  } as unknown as AuditService;

  const settings = {
    getAlertSettings: async () => ({
      enabled: true,
      webhookUrl: 'https://hooks.example/a',
      webhookSecret: 'topsecret',
    }),
  } as unknown as SettingsService;

  const notifier = {
    send: async (payload: unknown, target: unknown) => {
      sent.push({ payload, target });
      return (
        options.sendResult ?? {
          deliveryStatus: 'sent',
          deliveryError: null,
          notifiedAt: new Date('2026-10-20T00:00:05Z'),
        }
      );
    },
  } as unknown as AlertWebhookNotifier;

  return {
    svc: new AdminAlertsService(
      prisma as unknown as PrismaService,
      audit,
      settings,
      notifier,
    ),
    updateManyCalls,
    auditWrites,
    auditBestEffort,
    sent,
  };
}

describe('AdminAlertsService', () => {
  it('listRules 映射 DTO', async () => {
    const { svc } = makeService();
    const rules = await svc.listRules();
    expect(rules[0]).toEqual({
      id: 'rule1',
      key: 'run_failure_rate',
      name: '运行失败率',
      metric: 'run_failure_rate',
      comparator: 'gt',
      threshold: 0.5,
      windowMinutes: 15,
      cooldownMinutes: 30,
      severity: 'warning',
      enabled: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('updateRule 在事务内更新规则并审计', async () => {
    const { svc, auditWrites } = makeService();
    const rule = await svc.updateRule(
      'rule1',
      { threshold: 0.9, windowMinutes: 30, cooldownMinutes: 0, severity: 'critical' },
      actor,
    );
    expect(rule).toMatchObject({
      threshold: 0.9,
      windowMinutes: 30,
      cooldownMinutes: 0,
      severity: 'critical',
    });
    expect(auditWrites[0]).toMatchObject({
      action: 'alertRule.update',
      targetType: 'alert_rule',
      targetId: 'rule1',
    });
  });

  it('停用规则时同事务关闭未恢复事件', async () => {
    const { svc, updateManyCalls } = makeService();
    await svc.updateRule('rule1', { enabled: false }, actor);
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].where).toEqual({ ruleId: 'rule1', status: 'firing' });
    expect(updateManyCalls[0].data).toMatchObject({
      status: 'resolved',
      openKey: null,
      deliveryStatus: 'skipped',
      deliveryError: 'rule_disabled',
      notifiedAt: null,
      resolvedAt: expect.any(Date),
    });
  });

  it('updateRule 校验字段范围与未知键', async () => {
    const { svc } = makeService();
    for (const patch of [
      {},
      { foo: 1 },
      { threshold: 'x' },
      { windowMinutes: 0 },
      { windowMinutes: 1441 },
      { cooldownMinutes: -1 },
      { severity: 'info' },
      { enabled: 'yes' },
    ]) {
      await expect(svc.updateRule('rule1', patch, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    await expect(
      svc.updateRule('missing', { threshold: 1 }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listEvents 按状态与开始时间分页', async () => {
    const { svc } = makeService();
    const page = await svc.listEvents({
      status: 'firing',
      from: '2026-10-19T12:00:00Z',
      to: '2026-10-21T00:00:00Z',
      page: '1',
      pageSize: '10',
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: 'e1',
      status: 'firing',
      deliveryStatus: 'sent',
      startedAt: '2026-10-20T00:00:00.000Z',
      notifiedAt: '2026-10-20T00:00:05.000Z',
    });
    await expect(svc.listEvents({ status: 'open' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.listEvents({ from: 'not-a-date' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sendTest 构造 alert.test 载荷、投递并审计', async () => {
    const previous = process.env.ADMIN_WEB_URL;
    process.env.ADMIN_WEB_URL = 'https://ops.example/';
    try {
      const { svc, sent, auditBestEffort } = makeService();
      const result = await svc.sendTest('rule1', actor);
      expect(result).toEqual({
        deliveryStatus: 'sent',
        deliveryError: null,
        notifiedAt: '2026-10-20T00:00:05.000Z',
      });
      expect(sent[0].payload).toMatchObject({
        version: 1,
        type: 'alert.test',
        alert: {
          id: 'test',
          ruleKey: 'run_failure_rate',
          value: 0.5,
          message: '测试告警：运行失败率',
        },
        dashboardUrl: 'https://ops.example/admin/alerts',
      });
      expect(sent[0].target).toMatchObject({
        url: 'https://hooks.example/a',
        secret: 'topsecret',
      });
      expect(auditBestEffort[0]).toMatchObject({
        action: 'alertRule.test',
        targetType: 'alert_rule',
        targetId: 'rule1',
      });
    } finally {
      if (previous === undefined) delete process.env.ADMIN_WEB_URL;
      else process.env.ADMIN_WEB_URL = previous;
    }
  });

  it('sendTest 返回跳过结果且不吞掉错误摘要', async () => {
    const { svc } = makeService({
      sendResult: {
        deliveryStatus: 'skipped',
        deliveryError: 'webhook_not_configured',
        notifiedAt: null,
      },
    });
    await expect(svc.sendTest('rule1', actor)).resolves.toEqual({
      deliveryStatus: 'skipped',
      deliveryError: 'webhook_not_configured',
      notifiedAt: null,
    });
    await expect(svc.sendTest('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 10: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/admin/admin-alerts.service.test.ts
```

Expected: FAIL，`Cannot find module './admin-alerts.service'`。

- [ ] **Step 11: 实现告警管理服务与控制器**

`apps/bff/src/admin/admin-alerts.service.ts`：

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PageDto } from '@ai-office/shared';
import type {
  AdminAlertEventDto,
  AdminAlertRuleDto,
  AdminAlertTestResultDto,
} from '@ai-office/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import type { AdminActor } from '../audit/audit.types';
import {
  ALERT_TEST_PAYLOAD_ID,
  AlertWebhookNotifier,
  alertDashboardUrl,
  alertTarget,
  buildAlertPayload,
} from '../alerts/alert-webhook';
import { optionalDate, optionalString, parsePage } from './admin.util';

interface RulePatchData {
  threshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
  severity?: 'warning' | 'critical';
  enabled?: boolean;
}

interface AlertRuleRow {
  id: string;
  key: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface AlertEventRow {
  id: string;
  ruleId: string;
  ruleName: string;
  status: string;
  value: number;
  message: string;
  startedAt: Date;
  resolvedAt: Date | null;
  notifiedAt: Date | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
}

const PATCH_KEYS = new Set([
  'threshold',
  'windowMinutes',
  'cooldownMinutes',
  'severity',
  'enabled',
]);

function toRuleDto(row: AlertRuleRow): AdminAlertRuleDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    metric: row.metric,
    comparator: row.comparator === 'lt' ? 'lt' : 'gt',
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    cooldownMinutes: row.cooldownMinutes,
    severity: row.severity === 'critical' ? 'critical' : 'warning',
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEventDto(row: AlertEventRow): AdminAlertEventDto {
  const deliveryStatus =
    row.deliveryStatus === 'sent' ||
    row.deliveryStatus === 'failed' ||
    row.deliveryStatus === 'skipped'
      ? row.deliveryStatus
      : null;
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    status: row.status === 'resolved' ? 'resolved' : 'firing',
    value: row.value,
    message: row.message,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    notifiedAt: row.notifiedAt?.toISOString() ?? null,
    deliveryStatus,
    deliveryError: row.deliveryError,
  };
}

function parseIntField(value: unknown, code: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BadRequestException(code);
  }
  return value;
}

/** 只接受规格允许的五个可编辑字段，未知键与空 body 一律拒绝。 */
function parsePatch(body: unknown): RulePatchData {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('invalid_patch');
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !PATCH_KEYS.has(key))) {
    throw new BadRequestException('invalid_patch');
  }

  const data: RulePatchData = {};
  if (input.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || !Number.isFinite(input.threshold)) {
      throw new BadRequestException('invalid_threshold');
    }
    data.threshold = input.threshold;
  }
  if (input.windowMinutes !== undefined) {
    data.windowMinutes = parseIntField(input.windowMinutes, 'invalid_window', 1, 1440);
  }
  if (input.cooldownMinutes !== undefined) {
    data.cooldownMinutes = parseIntField(input.cooldownMinutes, 'invalid_cooldown', 0, 1440);
  }
  if (input.severity !== undefined) {
    if (input.severity !== 'warning' && input.severity !== 'critical') {
      throw new BadRequestException('invalid_severity');
    }
    data.severity = input.severity;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new BadRequestException('invalid_enabled');
    data.enabled = input.enabled;
  }
  return data;
}

/** 管理端告警：规则只允许改阈值/窗口/冷却/级别/启停，事件只读。 */
@Injectable()
export class AdminAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifier: AlertWebhookNotifier,
  ) {}

  async listRules(): Promise<AdminAlertRuleDto[]> {
    const rows = await this.prisma.alertRule.findMany({ orderBy: { key: 'asc' } });
    return rows.map(toRuleDto);
  }

  async updateRule(id: string, body: unknown, actor: AdminActor): Promise<AdminAlertRuleDto> {
    const data = parsePatch(body);

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.alertRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('alert_rule_not_found');

      const rule = await tx.alertRule.update({ where: { id }, data });
      if (data.enabled === false) {
        // 停用即视为恢复：否则未恢复事件会永久占着 firing 计数。
        await tx.alertEvent.updateMany({
          where: { ruleId: id, status: 'firing' },
          data: {
            status: 'resolved',
            resolvedAt: new Date(),
            openKey: null,
            deliveryStatus: 'skipped',
            deliveryError: 'rule_disabled',
            notifiedAt: null,
          },
        });
      }

      await this.audit.write(tx, actor, {
        action: 'alertRule.update',
        targetType: 'alert_rule',
        targetId: id,
        summary: { ...data },
      });
      return rule;
    });

    return toRuleDto(updated);
  }

  async listEvents(query: Record<string, unknown>): Promise<PageDto<AdminAlertEventDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const status = optionalString(query.status);
    if (status !== undefined && status !== 'firing' && status !== 'resolved') {
      throw new BadRequestException('invalid_status');
    }
    const from = optionalDate(query.from, 'invalid_from');
    const to = optionalDate(query.to, 'invalid_to');

    const where: Prisma.AlertEventWhereInput = {
      ...(status ? { status } : {}),
      ...(from || to
        ? {
            startedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.alertEvent.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.alertEvent.count({ where }),
    ]);

    return { items: rows.map(toEventDto), total, page, pageSize };
  }

  async sendTest(id: string, actor: AdminActor): Promise<AdminAlertTestResultDto> {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('alert_rule_not_found');

    const config = await this.settings.getAlertSettings();
    const now = new Date();
    const payload = buildAlertPayload(
      'alert.test',
      rule,
      {
        id: ALERT_TEST_PAYLOAD_ID,
        value: rule.threshold,
        message: `测试告警：${rule.name}`,
        startedAt: now,
      },
      alertDashboardUrl(),
    );
    // 测试投递与真实告警共用同一个限流器，避免测试绕开每小时配额。
    const delivery = await this.notifier.send(payload, alertTarget(config));

    await this.audit.bestEffort(actor, {
      action: 'alertRule.test',
      targetType: 'alert_rule',
      targetId: id,
      summary: {
        deliveryStatus: delivery.deliveryStatus,
        deliveryError: delivery.deliveryError,
      },
    });

    return {
      deliveryStatus: delivery.deliveryStatus,
      deliveryError: delivery.deliveryError,
      notifiedAt: delivery.notifiedAt?.toISOString() ?? null,
    };
  }
}
```

`apps/bff/src/admin/admin-alerts.controller.ts`：

```ts
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminAlertEventDto,
  AdminAlertRuleDto,
  AdminAlertTestResultDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminAlertsService } from './admin-alerts.service';

/** 管理端告警：规则编辑、事件检索与测试投递。 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAlertsController {
  constructor(private readonly alerts: AdminAlertsService) {}

  @Get('alert-rules')
  listRules(): Promise<AdminAlertRuleDto[]> {
    return this.alerts.listRules();
  }

  @Patch('alert-rules/:id')
  updateRule(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminAlertRuleDto> {
    return this.alerts.updateRule(id, body, actorOf(user, req));
  }

  @Get('alert-events')
  listEvents(@Query() query: Record<string, unknown>): Promise<PageDto<AdminAlertEventDto>> {
    return this.alerts.listEvents(query ?? {});
  }

  @Post('alert-rules/:id/test')
  sendTest(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminAlertTestResultDto> {
    return this.alerts.sendTest(id, actorOf(user, req));
  }
}
```

- [ ] **Step 12: 运行告警管理测试确认通过**

```bash
pnpm --filter @ai-office/bff test -- src/admin/admin-alerts.service.test.ts
```

Expected: 7 条 PASS。

- [ ] **Step 13: 写失败的时间线服务与路由测试**

`apps/bff/src/admin/admin-tasks.service.test.ts` 在 `describe('AdminTasksService')` 末尾新增：

```ts
  it('runTimeline 聚合节点、回传 traceId 与用量且不泄露正文', async () => {
    const { svc, audits } = makeService({
      runs: [
        {
          ...defaultRun,
          traceId: 'trace-1',
          steps: [
            {
              id: 's1',
              seq: 0,
              type: 'tool_call',
              payload: { tool: 'web.search', input: { q: '敏感入参' } },
              ts: new Date('2026-10-01T00:00:01Z'),
            },
            {
              id: 's2',
              seq: 1,
              type: 'tool_result',
              payload: { tool: 'web.search', ok: true, preview: '敏感结果' },
              ts: new Date('2026-10-01T00:00:03Z'),
            },
          ],
        },
      ],
    });
    const timeline = await svc.runTimeline('r1', actor);
    expect(timeline).toMatchObject({
      runId: 'r1',
      traceId: 'trace-1',
      status: 'done',
      durationMs: 60_000,
      truncated: false,
      usage: { credits: 7 },
    });
    expect(timeline.nodes.map((node) => node.kind)).toEqual(['accepted', 'tool', 'finished']);
    expect(JSON.stringify(timeline)).not.toContain('敏感');
    expect(audits[0]).toMatchObject({ action: 'run.timeline_view', targetId: 'r1' });
  });

  it('runTimeline 超过 500 个 step 时标记 truncated', async () => {
    const { svc } = makeService({
      runs: [
        {
          ...defaultRun,
          steps: Array.from({ length: 501 }, (_, index) => ({
            id: `s${index}`,
            seq: index,
            type: 'think',
            payload: {},
            ts: new Date('2026-10-01T00:00:01Z'),
          })),
        },
      ],
    });
    const timeline = await svc.runTimeline('r1', actor);
    expect(timeline.truncated).toBe(true);
    expect(timeline.nodes.length).toBeLessThanOrEqual(500);
    expect(timeline.nodes[timeline.nodes.length - 1].kind).toBe('notice');
  });

  it('runTimeline 不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.runTimeline('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
```

`apps/bff/src/admin/admin.endpoints.test.ts` 的 import 区增加：

```ts
import { AdminObservabilityController } from './admin-observability.controller';
import { AdminObservabilityService } from './admin-observability.service';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';
import { AdminTasksService } from './admin-tasks.service';
```

`describe('AppModule 装配')` 的用例改为：

```ts
  it('管理端 10 个控制器均已装配', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .compile();
    try {
      expect(moduleRef.get(AdminUsersController)).toBeInstanceOf(AdminUsersController);
      expect(moduleRef.get(AdminTenantsController)).toBeInstanceOf(AdminTenantsController);
      expect(moduleRef.get(AdminPlansController)).toBeInstanceOf(AdminPlansController);
      expect(moduleRef.get(AdminSessionsController)).toBeInstanceOf(AdminSessionsController);
      expect(moduleRef.get(AdminTasksController)).toBeInstanceOf(AdminTasksController);
      expect(moduleRef.get(AdminModelsController)).toBeInstanceOf(AdminModelsController);
      expect(moduleRef.get(AdminSettingsController)).toBeInstanceOf(AdminSettingsController);
      expect(moduleRef.get(AdminAuditController)).toBeInstanceOf(AdminAuditController);
      expect(moduleRef.get(AdminObservabilityController)).toBeInstanceOf(
        AdminObservabilityController,
      );
      expect(moduleRef.get(AdminAlertsController)).toBeInstanceOf(AdminAlertsController);
    } finally {
      await moduleRef.close();
    }
  });
```

文件末尾新增路由鉴权用例：

```ts
describe('概览、告警与时间线接口鉴权', () => {
  let adminApp: NestFastifyApplication;
  const overviewStub = {
    overview: async () => ({ range: '24h' }),
    timeseries: async () => ({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      granularity: 'hour',
      series: [],
    }),
  };
  const alertsStub = {
    listRules: async () => [],
    updateRule: async () => ({ id: 'r1' }),
    listEvents: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    sendTest: async () => ({
      deliveryStatus: 'skipped',
      deliveryError: 'webhook_not_configured',
      notifiedAt: null,
    }),
  };
  const tasksStub = { runTimeline: async () => ({ runId: 'r1', nodes: [] }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminObservabilityController, AdminAlertsController, AdminTasksController],
      providers: [
        { provide: AdminObservabilityService, useValue: overviewStub },
        { provide: AdminAlertsService, useValue: alertsStub },
        { provide: AdminTasksService, useValue: tasksStub },
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    adminApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await adminApp.init();
    await adminApp.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await adminApp.close();
  });

  const routes: Array<{ method: 'GET' | 'PATCH' | 'POST'; url: string; payload?: unknown }> = [
    { method: 'GET', url: '/api/admin/overview' },
    {
      method: 'GET',
      url: '/api/admin/metrics/timeseries?metrics=runs_started&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z',
    },
    { method: 'GET', url: '/api/admin/alert-rules' },
    { method: 'PATCH', url: '/api/admin/alert-rules/r1', payload: { enabled: true } },
    { method: 'GET', url: '/api/admin/alert-events' },
    { method: 'POST', url: '/api/admin/alert-rules/r1/test' },
    { method: 'GET', url: '/api/admin/runs/r1/timeline' },
  ];

  it('普通成员访问新增接口全部返回 403', async () => {
    const headers = { authorization: `Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}` };
    for (const route of routes) {
      const res = await adminApp.inject({ ...route, headers });
      expect(res.statusCode).toBe(403);
    }
  });

  it('管理员可访问概览、告警规则与时间线', async () => {
    const headers = { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` };
    const overviewRes = await adminApp.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers,
    });
    expect(overviewRes.statusCode).toBe(200);
    expect(JSON.parse(overviewRes.payload)).toMatchObject({ range: '24h' });

    const rulesRes = await adminApp.inject({
      method: 'GET',
      url: '/api/admin/alert-rules',
      headers,
    });
    expect(rulesRes.statusCode).toBe(200);
    expect(JSON.parse(rulesRes.payload)).toEqual([]);

    const timelineRes = await adminApp.inject({
      method: 'GET',
      url: '/api/admin/runs/r1/timeline',
      headers,
    });
    expect(timelineRes.statusCode).toBe(200);
    expect(JSON.parse(timelineRes.payload)).toMatchObject({ runId: 'r1' });
  });
});
```

- [ ] **Step 14: 运行测试确认失败**

```bash
pnpm --filter @ai-office/bff test -- src/admin/admin-tasks.service.test.ts src/admin/admin.endpoints.test.ts
```

Expected: FAIL，`runTimeline is not a function`，管理端控制器未装配返回 404。

- [ ] **Step 15: 实现时间线服务、路由与模块接线**

`apps/bff/src/admin/admin-tasks.service.ts` 的 DTO import 增加：

```ts
  AdminRunTimelineDto,
```

import 区增加：

```ts
import { buildTimelineNodes, TIMELINE_STEP_LIMIT } from './run-timeline';
```

在 `runDetail` 方法之后新增：

```ts
  async runTimeline(id: string, actor: AdminActor): Promise<AdminRunTimelineDto> {
    const row = await this.prisma.run.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { seq: 'asc' }, take: TIMELINE_STEP_LIMIT },
        _count: { select: { steps: true } },
      },
    });
    if (!row) throw new NotFoundException('run_not_found');

    const usage = await this.prisma.usageRecord.findUnique({ where: { runId: id } });
    await this.audit.bestEffort(actor, {
      action: 'run.timeline_view',
      targetType: 'run',
      targetId: id,
    });

    const { nodes, truncated } = buildTimelineNodes(
      row,
      row.steps.map((step) => ({
        id: step.id,
        seq: step.seq,
        type: step.type,
        payload: step.payload as Record<string, unknown>,
        ts: step.ts,
      })),
      row._count.steps,
    );

    return {
      runId: row.id,
      status: row.status,
      traceId: row.traceId,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      durationMs: row.endedAt
        ? Math.max(0, row.endedAt.getTime() - row.startedAt.getTime())
        : null,
      nodes,
      truncated,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            credits: usage.credits,
            models: usage.models,
          }
        : null,
    };
  }
```

`apps/bff/src/admin/admin-tasks.controller.ts` 的 DTO import 增加：

```ts
  AdminRunTimelineDto,
```

在 `runDetail` 路由之后新增：

```ts
  @Get('runs/:id/timeline')
  runTimeline(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminRunTimelineDto> {
    return this.tasks.runTimeline(id, actorOf(user, req));
  }
```

`apps/bff/src/admin/admin.module.ts` 改为：

```ts
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BillingModule } from '../billing/billing.module';
import { AlertsModule } from '../alerts/alerts.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPlansService } from './admin-plans.service';
import { AdminSessionsController } from './admin-sessions.controller';
import { AdminSessionsService } from './admin-sessions.service';
import { AdminTasksController } from './admin-tasks.controller';
import { AdminTasksService } from './admin-tasks.service';
import { AdminModelsController } from './admin-models.controller';
import { AdminModelsService } from './admin-models.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminObservabilityController } from './admin-observability.controller';
import { AdminObservabilityService } from './admin-observability.service';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';

/** 管理端模块：用户/租户/套餐/会话/任务/模型/参数/审计/概览/告警十组路由统一装配。 */
@Module({
  imports: [AuditModule, SettingsModule, BillingModule, AlertsModule],
  controllers: [
    AdminUsersController,
    AdminTenantsController,
    AdminPlansController,
    AdminSessionsController,
    AdminTasksController,
    AdminModelsController,
    AdminSettingsController,
    AdminAuditController,
    AdminObservabilityController,
    AdminAlertsController,
  ],
  providers: [
    AdminUsersService,
    AdminTenantsService,
    AdminPlansService,
    AdminSessionsService,
    AdminTasksService,
    AdminModelsService,
    AdminObservabilityService,
    AdminAlertsService,
  ],
})
export class AdminModule {}
```

- [ ] **Step 16: 跑测试与类型检查**

```bash
pnpm --filter @ai-office/bff test -- src/admin
pnpm --filter @ai-office/bff typecheck
```

Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 17: 提交**

```bash
git add apps/bff/src/admin
git commit -m "feat(admin): 提供运行概览、告警管理与运行时间线

指标快照与告警事件落库后，管理端仍看不到运营全貌，也无法在页面上
调阈值或排查单次运行。现在补齐概览/序列聚合接口、告警规则与事件
管理、测试投递，以及由 step 聚合出的时间线；时间线只保留工具名、
文件名和静态文案，避免把 prompt、入参与结果正文带到管理端。停用
规则会在同一事务里关闭未恢复事件，防止 firing 计数永久挂住。"
```

## Task 11: 管理端运行概览页与内联图表

本节把 Task 10 的 `/api/admin/overview` 与 `/api/admin/metrics/timeseries` 接到 Web 端。图表不引入第三方库：几何计算放到纯函数文件，组件只负责渲染内联 SVG，这样 Vitest 在没有 DOM 的环境里也能覆盖坐标、取整与堆叠逻辑。

**Files:**
- Create: `apps/web/src/components/chart-geometry.ts`
- Test: `apps/web/src/components/chart-geometry.test.ts`
- Create: `apps/web/src/components/metric-chart.tsx`
- Create: `apps/web/src/app/admin/overview/page.tsx`
- Modify: `apps/web/src/lib/admin-api.ts`
- Test: `apps/web/src/lib/admin-api.test.ts`
- Modify: `apps/web/src/components/admin-shell.tsx`
- Modify: `apps/web/src/app/admin/page.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: 写图表几何的失败测试**

创建 `apps/web/src/components/chart-geometry.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  formatCompact,
  formatDuration,
  lineGeometry,
  niceMax,
  stackSegments,
} from './chart-geometry';

describe('chart-geometry', () => {
  it('niceMax 向上取整到 1/2/5 的整十倍', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(23)).toBe(50);
    expect(niceMax(1200)).toBe(2000);
  });

  it('axisTicks 把 0 到上限均分', () => {
    expect(axisTicks(10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('lineGeometry 均分 x 轴并把数值映射到 y 轴', () => {
    const result = lineGeometry([0, 50, 100], 100, 100, 10, 100);
    expect(result.points).toEqual([
      { x: 10, y: 90 },
      { x: 50, y: 50 },
      { x: 90, y: 10 },
    ]);
    expect(result.path).toBe('M10,90 L50,50 L90,10');
  });

  it('lineGeometry 对越界值做夹取，单点不产生负坐标', () => {
    const result = lineGeometry([-10, 200], 100, 100, 10, 100);
    expect(result.points).toEqual([
      { x: 10, y: 90 },
      { x: 90, y: 10 },
    ]);
    expect(lineGeometry([5], 100, 100, 10, 10).points).toEqual([{ x: 10, y: 50 }]);
  });

  it('stackSegments 自下而上累计，跳过缺失桶', () => {
    const segments = stackSegments([[1, 2], [3, 0]], 0, 100, 4);
    expect(segments).toEqual([
      { start: 0, size: 25, value: 1 },
      { start: 25, size: 75, value: 3 },
    ]);
    expect(stackSegments([[1], [2]], 3, 100, 10)).toEqual([
      { start: 0, size: 0, value: 0 },
      { start: 0, size: 0, value: 0 },
    ]);
  });

  it('formatCompact 用 k/M 缩写', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(1000)).toBe('1k');
    expect(formatCompact(12500)).toBe('12.5k');
    expect(formatCompact(1_000_000)).toBe('1M');
    expect(formatCompact(-1500)).toBe('-1.5k');
    expect(formatCompact(Number.NaN)).toBe('—');
  });

  it('formatDuration 按毫秒/秒/分展示', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(12_400)).toBe('12.4s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/components/chart-geometry.test.ts`

Expected: FAIL，提示找不到模块 `./chart-geometry`。

- [ ] **Step 3: 实现纯函数**

创建 `apps/web/src/components/chart-geometry.ts`：

```ts
export interface ChartPoint {
  x: number;
  y: number;
}

export interface LineGeometry {
  path: string;
  points: ChartPoint[];
}

export interface StackSegment {
  start: number;
  size: number;
  value: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 坐标轴上限：向上取整到 1/2/5 的整十倍，避免刻度出现长小数。 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** 把 [0, max] 均分成 count 段，返回 count + 1 个刻度值。 */
export function axisTicks(max: number, count = 4): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, index) => round1(step * index));
}

/**
 * 折线几何：x 轴按点序均分，y 轴按 max 线性映射并夹取到 [0, max]。
 * max 非法时回退到 1，保证不会出现除零或 NaN 坐标。
 */
export function lineGeometry(
  values: number[],
  width: number,
  height: number,
  padding: number,
  max: number,
): LineGeometry {
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  const cap = max > 0 ? max : 1;
  const denominator = Math.max(1, values.length - 1);
  const points = values.map((value, index) => ({
    x: round1(padding + (innerWidth * index) / denominator),
    y: round1(padding + innerHeight - (innerHeight * Math.min(cap, Math.max(0, value))) / cap),
  }));
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');
  return { path, points };
}

/**
 * 计算某个时间桶内各系列的堆叠区间：start 是从柱子底部累计的偏移，
 * size 是该系列自身高度，value 保留原始数值供 tooltip 使用。
 */
export function stackSegments(
  valuesBySeries: number[][],
  bucket: number,
  innerHeight: number,
  max: number,
): StackSegment[] {
  const cap = max > 0 ? max : 1;
  let cursor = 0;
  return valuesBySeries.map((values) => {
    const value = Math.max(0, values[bucket] ?? 0);
    const size = (value / cap) * innerHeight;
    const segment = { start: cursor, size, value };
    cursor += size;
    return segment;
  });
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${Math.round(abs)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/components/chart-geometry.test.ts`

Expected: 7 个测试全部 PASS。

- [ ] **Step 5: 写主题图组件的测试（admin-api 查询串）**

`apps/web/src/lib/admin-api.test.ts` 顶部的导入改为：

```ts
import {
  adminErrorText,
  createModelPrice,
  getAdminMetricTimeseries,
  getAdminOverview,
  isForbidden,
  listAdminUsers,
  resetAdminSetting,
  updateModelPrice,
} from './admin-api';
```

在 `describe('admin-api', ...)` 的最后一个 `});` 之前追加：

```ts
  it('概览与序列请求带上范围、指标与维度参数', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getAdminOverview('7d');
    await getAdminMetricTimeseries({
      metrics: 'credits',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      granularity: 'day',
      dimensionType: 'model',
    });

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as [string])[0]));
    expect(urls[0]).toContain('/api/admin/overview?range=7d');
    expect(urls[1]).toContain(
      '/api/admin/metrics/timeseries?metrics=credits&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-02T00%3A00%3A00.000Z&granularity=day&dimensionType=model',
    );
    expect(urls[1]).not.toContain('dimensionId=');
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-api.test.ts`

Expected: FAIL，提示 `getAdminMetricTimeseries` / `getAdminOverview` 未导出。

- [ ] **Step 7: 增加 admin-api 函数**

`apps/web/src/lib/admin-api.ts` 顶部类型导入中补充（按字母序插入）：

```ts
  AdminMetricGranularity,
  AdminMetricTimeseriesDto,
  AdminMetricDimensionType,
  AdminOverviewDto,
  AdminOverviewRange,
```

在文件末尾追加：

```ts
// ------------------------------------------------------------------ 可观测性
export function getAdminOverview(range: AdminOverviewRange): Promise<AdminOverviewDto> {
  return request(`/api/admin/overview${query({ range })}`);
}

export interface AdminTimeseriesQuery {
  metrics: string;
  from: string;
  to: string;
  granularity?: AdminMetricGranularity;
  dimensionType?: AdminMetricDimensionType;
  dimensionId?: string;
}

export function getAdminMetricTimeseries(
  params: AdminTimeseriesQuery,
): Promise<AdminMetricTimeseriesDto> {
  // 显式展开字段：query 只接受简单记录，接口类型不能直接当作 Record 传入。
  return request(
    `/api/admin/metrics/timeseries${query({
      metrics: params.metrics,
      from: params.from,
      to: params.to,
      granularity: params.granularity,
      dimensionType: params.dimensionType,
      dimensionId: params.dimensionId,
    })}`,
  );
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-api.test.ts`

Expected: 全部 PASS。

- [ ] **Step 9: 实现 SVG 图表组件**

创建 `apps/web/src/components/metric-chart.tsx`：

```tsx
'use client';

import {
  axisTicks,
  formatCompact,
  lineGeometry,
  niceMax,
  stackSegments,
} from './chart-geometry';

export interface ChartSeries {
  name: string;
  values: number[];
}

const WIDTH = 640;
const HEIGHT = 240;
const PADDING = 40;
const INNER_WIDTH = WIDTH - PADDING * 2;
const INNER_HEIGHT = HEIGHT - PADDING * 2;

/** 8 色分类色板；超出的系列循环取色，图例仍按名称区分。 */
const COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4d7c0f',
];

function Legend({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <ul className="chart-legend">
      {names.map((name, index) => (
        <li key={`${name}-${index}`}>
          <span
            className="chart-swatch"
            style={{ background: COLORS[index % COLORS.length] }}
            aria-hidden="true"
          />
          {name}
        </li>
      ))}
    </ul>
  );
}

function YAxis({
  max,
  formatValue,
}: {
  max: number;
  formatValue: (value: number) => string;
}) {
  return (
    <>
      {axisTicks(max).map((tick) => {
        const y = PADDING + INNER_HEIGHT - (INNER_HEIGHT * tick) / max;
        return (
          <g key={tick}>
            <line x1={PADDING} y1={y} x2={WIDTH - PADDING} y2={y} className="chart-grid" />
            <text x={PADDING - 8} y={y + 4} textAnchor="end" className="chart-axis">
              {formatValue(tick)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** 只标首、中、尾三个时间点，窄屏上也不会互相压字。 */
function XAxisLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  const indices =
    labels.length <= 2
      ? labels.map((_, index) => index)
      : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  return (
    <>
      {indices.map((index) => (
        <text
          key={index}
          x={PADDING + (INNER_WIDTH * index) / Math.max(1, labels.length - 1)}
          y={HEIGHT - 12}
          textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}
          className="chart-axis"
        >
          {labels[index]}
        </text>
      ))}
    </>
  );
}

export function LineChart({
  title,
  labels,
  series,
  formatValue = formatCompact,
}: {
  title: string;
  labels: string[];
  series: ChartSeries[];
  formatValue?: (value: number) => string;
}) {
  const max = niceMax(Math.max(0, ...series.flatMap((item) => item.values)));
  const names = series.map((item) => item.name);
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}趋势图`}
      >
        <title>{title}</title>
        <desc>
          折线图，共 {labels.length} 个时间点；序列：{names.join('、') || '无'}。
        </desc>
        <YAxis max={max} formatValue={formatValue} />
        {series.map((item, index) => (
          <path
            key={item.name}
            d={lineGeometry(item.values, WIDTH, HEIGHT, PADDING, max).path}
            fill="none"
            stroke={COLORS[index % COLORS.length]}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
        <XAxisLabels labels={labels} />
      </svg>
      <Legend names={names} />
    </figure>
  );
}

export function StackedBarChart({
  title,
  labels,
  series,
}: {
  title: string;
  labels: string[];
  series: ChartSeries[];
}) {
  const totals = labels.map((_, index) =>
    series.reduce((sum, item) => sum + Math.max(0, item.values[index] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const slot = INNER_WIDTH / Math.max(1, labels.length);
  const barWidth = Math.max(2, slot * 0.6);
  const names = series.map((item) => item.name);
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}堆叠柱状图`}
      >
        <title>{title}</title>
        <desc>
          堆叠柱状图，共 {labels.length} 个时间点；自下而上依次为：
          {names.join('、') || '无'}。
        </desc>
        <YAxis max={max} formatValue={formatCompact} />
        {labels.map((label, index) => {
          const x = PADDING + slot * index + (slot - barWidth) / 2;
          const segments = stackSegments(
            series.map((item) => item.values),
            index,
            INNER_HEIGHT,
            max,
          );
          return (
            <g key={`${label}-${index}`}>
              {segments.map((segment, segmentIndex) =>
                segment.size > 0 ? (
                  <rect
                    key={series[segmentIndex].name}
                    x={x}
                    y={PADDING + INNER_HEIGHT - segment.start - segment.size}
                    width={barWidth}
                    height={segment.size}
                    fill={COLORS[segmentIndex % COLORS.length]}
                  >
                    <title>
                      {series[segmentIndex].name} · {label}：{formatCompact(segment.value)}
                    </title>
                  </rect>
                ) : null,
              )}
            </g>
          );
        })}
        <XAxisLabels labels={labels} />
      </svg>
      <Legend names={names} />
    </figure>
  );
}
```

- [ ] **Step 10: 实现运行概览页**

创建 `apps/web/src/app/admin/overview/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminMetricTimeseriesDto,
  AdminOverviewDto,
  AdminOverviewRange,
} from '@ai-office/shared';
import {
  adminErrorText,
  getAdminMetricTimeseries,
  getAdminOverview,
  isForbidden,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';
import {
  formatCompact,
  formatDuration,
} from '../../../components/chart-geometry';
import { LineChart, StackedBarChart } from '../../../components/metric-chart';

const RANGES: Array<{ value: AdminOverviewRange; label: string }> = [
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

const RANGE_MS: Record<AdminOverviewRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const HEALTH_NAMES: Record<string, string> = {
  db: '数据库',
  redis: '缓存',
  runtime: '运行时',
};

function bucketLabel(iso: string, range: AdminOverviewRange): string {
  const date = new Date(iso);
  return range === '24h'
    ? date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function deltaText(current: number, previous: number): string {
  if (!Number.isFinite(previous) || previous <= 0) return '较上一周期 —';
  const diff = ((current - previous) / previous) * 100;
  return `较上一周期 ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`;
}

/** 后端把尾部维度合并成 other；空维度只可能来自 global 序列。 */
function dimensionName(id: string): string {
  if (id === '') return '全部';
  if (id === 'other') return '其他';
  return id;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export default function AdminOverviewPage() {
  const router = useRouter();
  const [range, setRange] = useState<AdminOverviewRange>('24h');
  const [overview, setOverview] = useState<AdminOverviewDto | null>(null);
  const [credits, setCredits] = useState<AdminMetricTimeseriesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const seq = useRef(0);
  const load = useCallback(
    async (silent = false) => {
      const id = ++seq.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const end = new Date();
        const start = new Date(end.getTime() - RANGE_MS[range]);
        const [nextOverview, nextCredits] = await Promise.all([
          getAdminOverview(range),
          getAdminMetricTimeseries({
            metrics: 'credits',
            from: start.toISOString(),
            to: end.toISOString(),
            granularity: range === '24h' ? 'hour' : 'day',
            dimensionType: 'model',
          }),
        ]);
        // 切换范围或自动刷新交错时，只让最后一次请求写状态。
        if (id !== seq.current) return;
        setOverview(nextOverview);
        setCredits(nextCredits);
      } catch (err) {
        if (id !== seq.current) return;
        handleErr(err);
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [range, handleErr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 每 60 秒静默刷新；标签页隐藏时跳过，重新可见时立即补一次。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const points = overview?.series ?? [];
  const labels = points.map((point) => bucketLabel(point.bucketStart, overview?.range ?? range));
  const creditLabels = (credits?.series[0]?.points ?? []).map((point) =>
    bucketLabel(point.bucketStart, range),
  );
  const creditSeries = (credits?.series ?? []).map((item) => ({
    name: dimensionName(item.dimensionId),
    values: item.points.map((point) => point.value),
  }));
  const modelCostTotal = (overview?.modelCosts ?? []).reduce(
    (sum, item) => sum + item.credits,
    0,
  );

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">运行概览</h1>
            <p className="page-sub">运营指标、成本与告警态势；每 60 秒自动刷新。</p>
          </div>
          <div className="page-head-actions">
            <div className="overview-range" role="group" aria-label="时间范围">
              {RANGES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`admin-btn${range === item.value ? ' primary' : ''}`}
                  aria-pressed={range === item.value}
                  onClick={() => setRange(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading && !overview ? (
          <div className="admin-empty">加载中…</div>
        ) : !overview ? (
          <div className="admin-empty">{error ? '加载失败' : '暂无数据'}</div>
        ) : (
          <>
            <section className="kpi-grid" aria-label="核心指标" aria-busy={loading}>
              <Kpi
                label="运行总数"
                value={formatCompact(overview.current.runs)}
                hint={deltaText(overview.current.runs, overview.previous.runs)}
              />
              <Kpi
                label="成功率"
                value={percent(overview.current.successRate)}
                hint={`${overview.current.failedRuns} 次失败`}
              />
              <Kpi
                label="输入 Token"
                value={formatCompact(overview.current.inputTokens)}
                hint={deltaText(overview.current.inputTokens, overview.previous.inputTokens)}
              />
              <Kpi
                label="输出 Token"
                value={formatCompact(overview.current.outputTokens)}
                hint={deltaText(overview.current.outputTokens, overview.previous.outputTokens)}
              />
              <Kpi
                label="积分消耗"
                value={formatCompact(overview.current.credits)}
                hint={deltaText(overview.current.credits, overview.previous.credits)}
              />
              <Kpi
                label="平均运行时长"
                value={formatDuration(overview.current.avgDurationMs)}
                hint={`P95 ${formatDuration(overview.current.p95DurationMs)}`}
              />
              <Kpi
                label="未恢复告警"
                value={String(overview.current.unresolvedAlerts)}
                hint="全部时间"
              />
            </section>

            <section className="overview-grid" aria-label="趋势图">
              <LineChart
                title="运行量与失败量"
                labels={labels}
                series={[
                  { name: '运行', values: points.map((point) => point.runs) },
                  { name: '失败', values: points.map((point) => point.failedRuns) },
                ]}
              />
              <LineChart
                title="Token 消耗"
                labels={labels}
                series={[
                  { name: '输入', values: points.map((point) => point.inputTokens) },
                  { name: '输出', values: points.map((point) => point.outputTokens) },
                ]}
              />
              {creditSeries.length === 0 || creditLabels.length === 0 ? (
                <figure className="chart">
                  <figcaption className="chart-title">积分消耗（按模型堆叠）</figcaption>
                  <div className="admin-empty">该区间暂无按模型统计的积分数据</div>
                </figure>
              ) : (
                <StackedBarChart
                  title="积分消耗（按模型堆叠）"
                  labels={creditLabels}
                  series={creditSeries}
                />
              )}
              <LineChart
                title="平均运行时长"
                labels={labels}
                series={[
                  {
                    name: '平均时长',
                    values: points.map((point) => point.avgDurationMs ?? 0),
                  },
                ]}
                formatValue={formatDuration}
              />
            </section>

            <section className="overview-grid" aria-label="成本与健康">
              <section className="admin-panel">
                <h2 className="billing-heading">模型积分分布</h2>
                {overview.modelCosts.length === 0 ? (
                  <div className="admin-empty">暂无数据</div>
                ) : (
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th className="numeric">积分</th>
                        <th className="numeric">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.modelCosts.map((item) => (
                        <tr key={item.model}>
                          <td>{item.model}</td>
                          <td className="numeric">{formatCompact(item.credits)}</td>
                          <td className="numeric">
                            {modelCostTotal > 0
                              ? `${((item.credits / modelCostTotal) * 100).toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="admin-panel">
                <h2 className="billing-heading">服务健康</h2>
                {overview.serviceHealth.length === 0 ? (
                  <div className="admin-empty">暂无数据</div>
                ) : (
                  <ul className="health-list">
                    {overview.serviceHealth.map((item) => (
                      <li key={item.name} className="health-item">
                        <span
                          className={`health-dot${item.up ? ' up' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="health-name">
                          {HEALTH_NAMES[item.name] ?? item.name}
                        </span>
                        <span className="health-state">{item.up ? '正常' : '异常'}</span>
                        <span className="admin-muted">
                          {new Date(item.checkedAt).toLocaleTimeString('zh-CN', {
                            hour12: false,
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </section>

            <p className="admin-muted" aria-live="polite">
              {refreshing
                ? '正在刷新…'
                : `数据生成于 ${new Date(overview.generatedAt).toLocaleString('zh-CN', {
                    hour12: false,
                  })}`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 11: 接入导航并改默认重定向**

`apps/web/src/components/admin-shell.tsx` 的 `NAV` 数组最前面加入：

```ts
  { href: '/admin/overview', label: '运行概览' },
```

`apps/web/src/app/admin/page.tsx` 整体改为：

```tsx
import { redirect } from 'next/navigation';

export default function AdminIndexPage() {
  redirect('/admin/overview');
}
```

- [ ] **Step 12: 补样式**

`apps/web/src/app/globals.css` 末尾追加：

```css
/* ================================ 运行概览 ================================ */

.overview-range {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.kpi-card {
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.kpi-label {
  font-size: 12px;
  color: var(--ink-2);
}

.kpi-value {
  margin-top: 4px;
  font-size: 24px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.kpi-hint {
  margin-top: 2px;
  font-size: 11px;
  color: var(--ink-3);
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.overview-grid > .admin-panel {
  margin-bottom: 0;
}

.chart {
  min-width: 0;
  margin: 0;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.chart-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}

.chart-svg {
  display: block;
  width: 100%;
  height: auto;
}

.chart-grid {
  stroke: var(--line);
  stroke-width: 1;
}

.chart-axis {
  fill: var(--ink-3);
  font-size: 10px;
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--ink-2);
}

.chart-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chart-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.health-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.health-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
}

.health-dot.up {
  background: var(--mint);
}

.health-name {
  min-width: 64px;
}

.health-state {
  color: var(--ink-2);
}

@media (max-width: 900px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 13: 跑 web 测试与类型检查**

```bash
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web exec tsc --noEmit
```

Expected: 全部测试 PASS；tsc 无输出。

- [ ] **Step 14: 提交**

```bash
git add apps/web/src/components apps/web/src/app/admin apps/web/src/lib/admin-api.ts apps/web/src/lib/admin-api.test.ts
git commit -m "feat(web): 新增管理端运行概览页

后台此前只有明细列表，运营无法一眼判断运行量、失败率、Token 与积分
走势，也看不到服务健康。现在新增概览页：KPI 对比上一周期，折线与按
模型堆叠的积分图都用内联 SVG 绘制，不引入图表依赖；页面每 60 秒静默
刷新，标签页隐藏时暂停，并用请求序号丢弃过期响应。图表几何与数值
格式化抽成纯函数单独测试，避免测试依赖浏览器渲染。"
```

---

## Task 12: 管理端告警中心

Task 10 已提供规则、事件与测试投递接口。本节新增 `/admin/alerts`：规则以表格形式就地编辑，事件按状态筛选并分页。数值校验与投递文案放在纯函数里，先由前端拦下明显错误，服务端仍是最终校验方。

**Files:**
- Create: `apps/web/src/lib/alert-draft.ts`
- Test: `apps/web/src/lib/alert-draft.test.ts`
- Modify: `apps/web/src/lib/admin-api.ts`
- Test: `apps/web/src/lib/admin-api.test.ts`
- Create: `apps/web/src/app/admin/alerts/page.tsx`
- Modify: `apps/web/src/components/admin-shell.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: 写规则草稿的失败测试**

创建 `apps/web/src/lib/alert-draft.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { AdminAlertRuleDto } from '@ai-office/shared';
import { alertDeliveryText, parseAlertDraft, toDraft } from './alert-draft';

const rule: AdminAlertRuleDto = {
  id: 'r1',
  key: 'run_failure_rate',
  name: '运行失败率',
  metric: 'run_failure_rate',
  comparator: 'gt',
  threshold: 0.2,
  windowMinutes: 15,
  cooldownMinutes: 60,
  severity: 'warning',
  enabled: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('alert-draft', () => {
  it('toDraft 把数值转成输入框文本', () => {
    expect(toDraft(rule)).toEqual({
      threshold: '0.2',
      windowMinutes: '15',
      cooldownMinutes: '60',
      severity: 'warning',
      enabled: true,
    });
  });

  it('parseAlertDraft 接受合法输入并保留 0 值', () => {
    const parsed = parseAlertDraft({
      threshold: '0',
      windowMinutes: '1',
      cooldownMinutes: '0',
      severity: 'critical',
      enabled: false,
    });
    expect(parsed).toEqual({
      ok: true,
      patch: {
        threshold: 0,
        windowMinutes: 1,
        cooldownMinutes: 0,
        severity: 'critical',
        enabled: false,
      },
    });
  });

  it('parseAlertDraft 拦截非数字阈值与越界窗口', () => {
    expect(parseAlertDraft({ ...toDraft(rule), threshold: '' })).toEqual({
      ok: false,
      error: '阈值必须是数字',
    });
    expect(parseAlertDraft({ ...toDraft(rule), threshold: 'abc' })).toEqual({
      ok: false,
      error: '阈值必须是数字',
    });
    expect(parseAlertDraft({ ...toDraft(rule), windowMinutes: '1.5' })).toEqual({
      ok: false,
      error: '统计窗口必须是 1–1440 的整数分钟',
    });
    expect(parseAlertDraft({ ...toDraft(rule), windowMinutes: '0' })).toEqual({
      ok: false,
      error: '统计窗口必须是 1–1440 的整数分钟',
    });
    expect(parseAlertDraft({ ...toDraft(rule), cooldownMinutes: '-1' })).toEqual({
      ok: false,
      error: '冷却时间必须是 0–1440 的整数分钟',
    });
  });

  it('alertDeliveryText 把内部投递码翻成运营能看懂的状态', () => {
    expect(alertDeliveryText(null, null)).toBe('未投递');
    expect(alertDeliveryText('sent', null)).toBe('已投递');
    expect(alertDeliveryText('skipped', 'webhook_not_configured')).toBe('未配置 Webhook');
    expect(alertDeliveryText('skipped', 'rate_limited')).toBe('超出每小时配额');
    expect(alertDeliveryText('skipped', 'rule_disabled')).toBe('规则已停用');
    expect(alertDeliveryText('skipped', 'something_else')).toBe('已跳过');
    expect(alertDeliveryText('failed', 'http_500')).toBe('投递失败（HTTP 500）');
    expect(alertDeliveryText('failed', 'timeout')).toBe('投递失败');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/alert-draft.test.ts`

Expected: FAIL，提示找不到模块 `./alert-draft`。

- [ ] **Step 3: 实现草稿与投递文案**

创建 `apps/web/src/lib/alert-draft.ts`：

```ts
import type { AdminAlertRuleDto, AdminAlertRulePatch } from '@ai-office/shared';

export interface AlertRuleDraft {
  threshold: string;
  windowMinutes: string;
  cooldownMinutes: string;
  severity: 'warning' | 'critical';
  enabled: boolean;
}

export function toDraft(rule: AdminAlertRuleDto): AlertRuleDraft {
  return {
    threshold: String(rule.threshold),
    windowMinutes: String(rule.windowMinutes),
    cooldownMinutes: String(rule.cooldownMinutes),
    severity: rule.severity,
    enabled: rule.enabled,
  };
}

export type DraftParseResult =
  | { ok: true; patch: AdminAlertRulePatch }
  | { ok: false; error: string };

/** 前端预校验与服务端保持同一组边界；最终仍以 PATCH 的校验结果为准。 */
export function parseAlertDraft(draft: AlertRuleDraft): DraftParseResult {
  const threshold = Number(draft.threshold);
  if (draft.threshold.trim() === '' || !Number.isFinite(threshold)) {
    return { ok: false, error: '阈值必须是数字' };
  }
  const windowMinutes = Number(draft.windowMinutes);
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
    return { ok: false, error: '统计窗口必须是 1–1440 的整数分钟' };
  }
  const cooldownMinutes = Number(draft.cooldownMinutes);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1440) {
    return { ok: false, error: '冷却时间必须是 0–1440 的整数分钟' };
  }
  return {
    ok: true,
    patch: {
      threshold,
      windowMinutes,
      cooldownMinutes,
      severity: draft.severity,
      enabled: draft.enabled,
    },
  };
}

export function alertDeliveryText(
  status: 'sent' | 'failed' | 'skipped' | null,
  error: string | null,
): string {
  if (status === null) return '未投递';
  if (status === 'sent') return '已投递';
  if (status === 'failed') {
    return error?.startsWith('http_') ? `投递失败（HTTP ${error.slice(5)}）` : '投递失败';
  }
  const map: Record<string, string> = {
    webhook_not_configured: '未配置 Webhook',
    webhook_url_empty: '未配置 Webhook',
    invalid_url: 'Webhook 地址无效',
    rate_limited: '超出每小时配额',
    rule_disabled: '规则已停用',
  };
  return map[error ?? ''] ?? '已跳过';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/lib/alert-draft.test.ts`

Expected: 4 个测试全部 PASS。

- [ ] **Step 5: 写 admin-api 告警接口的失败测试**

`apps/web/src/lib/admin-api.test.ts` 顶部导入改为：

```ts
import {
  adminErrorText,
  createModelPrice,
  getAdminMetricTimeseries,
  getAdminOverview,
  isForbidden,
  listAdminAlertEvents,
  listAdminAlertRules,
  listAdminUsers,
  resetAdminSetting,
  sendAdminAlertTest,
  updateAdminAlertRule,
  updateModelPrice,
} from './admin-api';
```

在 `describe('admin-api', ...)` 的最后一个 `});` 之前追加：

```ts
  it('告警规则、事件与测试投递使用正确的方法和参数', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listAdminAlertRules();
    await updateAdminAlertRule('r/1', { threshold: 0.5, enabled: false });
    await listAdminAlertEvents({ status: 'firing', page: 2, pageSize: 20 });
    await sendAdminAlertTest('r/1');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toContain('/api/admin/alert-rules');
    expect(String(calls[1][0])).toContain('/api/admin/alert-rules/r%2F1');
    expect(calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ threshold: 0.5, enabled: false });
    expect(String(calls[2][0])).toContain(
      '/api/admin/alert-events?status=firing&page=2&pageSize=20',
    );
    expect(String(calls[3][0])).toContain('/api/admin/alert-rules/r%2F1/test');
    expect(calls[3][1].method).toBe('POST');
  });

  it('告警规则校验失败有专门文案', () => {
    expect(adminErrorText(new Error('admin_failed_400_invalid_patch'))).toBe(
      '告警规则参数不合法',
    );
    expect(adminErrorText(new Error('admin_failed_404_alert_rule_not_found'))).toBe(
      '告警规则不存在',
    );
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-api.test.ts`

Expected: FAIL，提示 `listAdminAlertRules` 等未导出。

- [ ] **Step 7: 实现告警 API 与错误文案**

`apps/web/src/lib/admin-api.ts` 顶部类型导入补充（按字母序插入）：

```ts
  AdminAlertEventDto,
  AdminAlertRuleDto,
  AdminAlertRulePatch,
  AdminAlertTestResultDto,
```

`adminErrorText` 的 `map` 中追加：

```ts
    'admin_failed_400_invalid_patch': '告警规则参数不合法',
    'admin_failed_404_alert_rule_not_found': '告警规则不存在',
```

在文件末尾追加：

```ts
// ------------------------------------------------------------------ 告警
export function listAdminAlertRules(): Promise<AdminAlertRuleDto[]> {
  return request('/api/admin/alert-rules');
}

export function updateAdminAlertRule(
  id: string,
  patch: AdminAlertRulePatch,
): Promise<AdminAlertRuleDto> {
  return request(`/api/admin/alert-rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function listAdminAlertEvents(params: {
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Promise<PageDto<AdminAlertEventDto>> {
  return request(`/api/admin/alert-events${query(params)}`);
}

export function sendAdminAlertTest(id: string): Promise<AdminAlertTestResultDto> {
  return request(`/api/admin/alert-rules/${encodeURIComponent(id)}/test`, { method: 'POST' });
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-api.test.ts`

Expected: 全部 PASS。

- [ ] **Step 9: 实现告警中心页**

创建 `apps/web/src/app/admin/alerts/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminAlertEventDto, AdminAlertRuleDto } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminAlertEvents,
  listAdminAlertRules,
  sendAdminAlertTest,
  updateAdminAlertRule,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';
import {
  alertDeliveryText,
  parseAlertDraft,
  toDraft,
  type AlertRuleDraft,
} from '../../../lib/alert-draft';

export default function AdminAlertsPage() {
  const router = useRouter();
  const [rules, setRules] = useState<AdminAlertRuleDto[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AlertRuleDraft>>({});
  const [events, setEvents] = useState<AdminAlertEventDto[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventPage, setEventPage] = useState(1);
  const [eventStatus, setEventStatus] = useState<'' | 'firing' | 'resolved'>('');
  const [rulesLoading, setRulesLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [testingId, setTestingId] = useState('');
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const rulesSeq = useRef(0);
  const loadRules = useCallback(async () => {
    const id = ++rulesSeq.current;
    setRulesLoading(true);
    try {
      const data = await listAdminAlertRules();
      if (id !== rulesSeq.current) return;
      setRules(data);
      setDrafts(Object.fromEntries(data.map((rule) => [rule.id, toDraft(rule)] as const)));
    } catch (err) {
      if (id === rulesSeq.current) handleErr(err);
    } finally {
      if (id === rulesSeq.current) setRulesLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const eventsSeq = useRef(0);
  const loadEvents = useCallback(async () => {
    const id = ++eventsSeq.current;
    setEventsLoading(true);
    try {
      const data = await listAdminAlertEvents({
        status: eventStatus || undefined,
        page: eventPage,
        pageSize: 20,
      });
      if (id !== eventsSeq.current) return;
      setEvents(data.items);
      setEventsTotal(data.total);
    } catch (err) {
      if (id === eventsSeq.current) handleErr(err);
    } finally {
      if (id === eventsSeq.current) setEventsLoading(false);
    }
  }, [eventStatus, eventPage, handleErr]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  function updateDraft(id: string, patch: Partial<AlertRuleDraft>) {
    setDrafts((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }

  async function saveRule(rule: AdminAlertRuleDto) {
    const draft = drafts[rule.id];
    if (!draft) return;
    const parsed = parseAlertDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSavingId(rule.id);
    setError('');
    try {
      const updated = await updateAdminAlertRule(rule.id, parsed.patch);
      setRules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setDrafts((prev) => ({ ...prev, [updated.id]: toDraft(updated) }));
    } catch (err) {
      handleErr(err);
    } finally {
      setSavingId('');
    }
  }

  async function testRule(rule: AdminAlertRuleDto) {
    setTestingId(rule.id);
    setError('');
    try {
      const result = await sendAdminAlertTest(rule.id);
      setTestResults((prev) => ({
        ...prev,
        [rule.id]: alertDeliveryText(result.deliveryStatus, result.deliveryError),
      }));
    } catch (err) {
      handleErr(err);
    } finally {
      setTestingId('');
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">告警中心</h1>
            <p className="page-sub">调整规则阈值、查看触发记录并验证 Webhook 投递。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <section className="admin-panel">
          <h2 className="billing-heading">告警规则</h2>
          {rulesLoading ? (
            <div className="admin-empty">加载中…</div>
          ) : rules.length === 0 ? (
            <div className="admin-empty">暂无规则</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>规则</th>
                  <th>条件</th>
                  <th>阈值</th>
                  <th>窗口(分)</th>
                  <th>冷却(分)</th>
                  <th>级别</th>
                  <th>启用</th>
                  <th>测试结果</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const draft = drafts[rule.id] ?? toDraft(rule);
                  return (
                    <tr key={rule.id}>
                      <td>
                        <div>{rule.name}</div>
                        <div className="admin-muted">{rule.key}</div>
                      </td>
                      <td className="admin-muted">
                        {rule.metric} {rule.comparator === 'gt' ? '>' : '<'}
                      </td>
                      <td>
                        <input
                          className="admin-input alert-cell-input"
                          type="number"
                          step="any"
                          value={draft.threshold}
                          aria-label={`${rule.name} 阈值`}
                          onChange={(event) =>
                            updateDraft(rule.id, { threshold: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="admin-input alert-cell-input"
                          type="number"
                          min={1}
                          max={1440}
                          step={1}
                          value={draft.windowMinutes}
                          aria-label={`${rule.name} 统计窗口`}
                          onChange={(event) =>
                            updateDraft(rule.id, { windowMinutes: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="admin-input alert-cell-input"
                          type="number"
                          min={0}
                          max={1440}
                          step={1}
                          value={draft.cooldownMinutes}
                          aria-label={`${rule.name} 冷却时间`}
                          onChange={(event) =>
                            updateDraft(rule.id, { cooldownMinutes: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          className="admin-input"
                          value={draft.severity}
                          aria-label={`${rule.name} 级别`}
                          onChange={(event) =>
                            updateDraft(rule.id, {
                              severity: event.target.value as 'warning' | 'critical',
                            })
                          }
                        >
                          <option value="warning">警告</option>
                          <option value="critical">严重</option>
                        </select>
                      </td>
                      <td>
                        <label className="alert-enabled">
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            aria-label={`${rule.name} 启用`}
                            onChange={(event) =>
                              updateDraft(rule.id, { enabled: event.target.checked })
                            }
                          />
                          {draft.enabled ? '启用' : '停用'}
                        </label>
                      </td>
                      <td className="admin-muted">{testResults[rule.id] ?? '—'}</td>
                      <td>
                        <div className="alert-actions">
                          <button
                            type="button"
                            className="admin-btn primary"
                            disabled={savingId !== ''}
                            onClick={() => void saveRule(rule)}
                          >
                            {savingId === rule.id ? '保存中…' : '保存'}
                          </button>
                          <button
                            type="button"
                            className="admin-btn"
                            disabled={testingId !== ''}
                            onClick={() => void testRule(rule)}
                          >
                            {testingId === rule.id ? '发送中…' : '发送测试'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="admin-muted" style={{ marginTop: 8 }}>
            停用规则会同时关闭其未恢复事件；测试告警与真实告警共用每小时配额。
          </p>
        </section>

        <section className="admin-panel">
          <div className="admin-toolbar" style={{ marginBottom: 12 }}>
            <h2 className="billing-heading" style={{ margin: 0 }}>
              告警事件
            </h2>
            <select
              className="admin-input"
              value={eventStatus}
              aria-label="事件状态"
              onChange={(event) => {
                setEventPage(1);
                setEventStatus(event.target.value as '' | 'firing' | 'resolved');
              }}
            >
              <option value="">全部状态</option>
              <option value="firing">触发中</option>
              <option value="resolved">已恢复</option>
            </select>
            <span className="admin-muted">共 {eventsTotal} 条</span>
          </div>

          {eventsLoading ? (
            <div className="admin-empty">加载中…</div>
          ) : events.length === 0 ? (
            <div className="admin-empty">暂无事件</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>规则</th>
                  <th>值</th>
                  <th>消息</th>
                  <th>开始</th>
                  <th>恢复</th>
                  <th>投递</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <span className={`alert-badge ${event.status}`}>
                        {event.status === 'firing' ? '触发中' : '已恢复'}
                      </span>
                    </td>
                    <td>{event.ruleName}</td>
                    <td className="numeric">{event.value}</td>
                    <td>{event.message}</td>
                    <td>{new Date(event.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>
                      {event.resolvedAt
                        ? new Date(event.resolvedAt).toLocaleString('zh-CN', { hour12: false })
                        : '—'}
                    </td>
                    <td className="admin-muted">
                      {alertDeliveryText(event.deliveryStatus, event.deliveryError)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="admin-pager">
            <button
              type="button"
              className="admin-btn"
              disabled={eventPage <= 1 || eventsLoading}
              onClick={() => setEventPage((page) => Math.max(1, page - 1))}
            >
              上一页
            </button>
            <span>第 {eventPage} 页</span>
            <button
              type="button"
              className="admin-btn"
              disabled={eventPage * 20 >= eventsTotal || eventsLoading}
              onClick={() => setEventPage((page) => page + 1)}
            >
              下一页
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 10: 导航加入告警中心**

`apps/web/src/components/admin-shell.tsx` 的 `NAV` 数组在「运行概览」之后加入：

```ts
  { href: '/admin/alerts', label: '告警中心' },
```

- [ ] **Step 11: 补样式**

`apps/web/src/app/globals.css` 末尾追加：

```css
/* ================================ 告警中心 ================================ */

.alert-cell-input {
  width: 96px;
}

.alert-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.alert-enabled {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.alert-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
}

.alert-badge.firing {
  color: var(--danger);
  background: var(--danger-soft);
}

.alert-badge.resolved {
  color: var(--mint-ink);
  background: var(--mint-soft);
}
```

- [ ] **Step 12: 跑 web 测试与类型检查**

```bash
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web exec tsc --noEmit
```

Expected: 全部测试 PASS；tsc 无输出。

- [ ] **Step 13: 提交**

```bash
git add apps/web/src/lib/alert-draft.ts apps/web/src/lib/alert-draft.test.ts apps/web/src/lib/admin-api.ts apps/web/src/lib/admin-api.test.ts apps/web/src/app/admin/alerts apps/web/src/components/admin-shell.tsx apps/web/src/app/globals.css
git commit -m "feat(web): 新增管理端告警中心

规则与事件接口就绪后，运营仍只能查库改阈值。现在新增告警中心：
可在表格里调整阈值、窗口、冷却、级别和启停，事件表支持状态筛选与
分页，并可直接发送测试告警验证 Webhook。草稿解析与投递文案抽成纯
函数，前端先挡非法数值，服务端仍做最终校验；停用规则的副作用在
页面上明确提示。"
```

---

## Task 13: 运行时间线、环境变量与交付文档

最后一节把 Task 10 的 `/api/admin/runs/:id/timeline` 接到任务排障页，并补齐部署所需的开关、指标抓取说明与验收步骤。时间线节点只展示服务端聚合后的工具名、文件名和静态文案，页面不再读取 step payload。

**Files:**
- Create: `apps/web/src/lib/run-timeline.ts`
- Test: `apps/web/src/lib/run-timeline.test.ts`
- Modify: `apps/web/src/lib/admin-api.ts`
- Test: `apps/web/src/lib/admin-api.test.ts`
- Modify: `apps/web/src/app/admin/tasks/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `.env.example`
- Modify: `turbo.json`
- Modify: `docs/deploy/06-deployment.md`
- Modify: `docs/develop/05-dev-plan.md`

- [ ] **Step 1: 写时间线文案映射的失败测试**

创建 `apps/web/src/lib/run-timeline.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { timelineKindLabel, timelineStatusLabel, timelineStatusTone } from './run-timeline';

describe('run-timeline', () => {
  it('已知类型与状态返回中文标签', () => {
    expect(timelineKindLabel('think')).toBe('思考');
    expect(timelineKindLabel('tool')).toBe('工具');
    expect(timelineKindLabel('notice')).toBe('提示');
    expect(timelineStatusLabel('denied')).toBe('已拒绝');
    expect(timelineStatusLabel('blocked')).toBe('已拦截');
  });

  it('未知值回退到通用文案，避免后端新增类型导致空白', () => {
    expect(timelineKindLabel('future_kind')).toBe('事件');
    expect(timelineStatusLabel('future_status')).toBe('未知');
  });

  it('状态归并成四种视觉语气', () => {
    expect(timelineStatusTone('ok')).toBe('ok');
    expect(timelineStatusTone('done')).toBe('ok');
    expect(timelineStatusTone('failed')).toBe('bad');
    expect(timelineStatusTone('blocked')).toBe('bad');
    expect(timelineStatusTone('denied')).toBe('warn');
    expect(timelineStatusTone('running')).toBe('active');
    expect(timelineStatusTone('future_status')).toBe('active');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/run-timeline.test.ts`

Expected: FAIL，提示找不到模块 `./run-timeline`。

- [ ] **Step 3: 实现映射纯函数**

创建 `apps/web/src/lib/run-timeline.ts`：

```ts
import type { AdminTimelineNodeKind, AdminTimelineNodeStatus } from '@ai-office/shared';

const KIND_LABEL: Record<AdminTimelineNodeKind, string> = {
  accepted: '已受理',
  think: '思考',
  tool: '工具',
  confirm: '确认',
  artifact: '成果',
  notice: '提示',
  finished: '完成',
};

const STATUS_LABEL: Record<AdminTimelineNodeStatus, string> = {
  ok: '成功',
  failed: '失败',
  denied: '已拒绝',
  blocked: '已拦截',
  running: '进行中',
  done: '完成',
};

export type TimelineTone = 'ok' | 'bad' | 'warn' | 'active';

/** 后端新增枚举时前端仍能显示，不因未知值出现空白节点。 */
export function timelineKindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? '事件';
}

export function timelineStatusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? '未知';
}

export function timelineStatusTone(status: string): TimelineTone {
  switch (status) {
    case 'ok':
    case 'done':
      return 'ok';
    case 'failed':
    case 'blocked':
      return 'bad';
    case 'denied':
      return 'warn';
    default:
      return 'active';
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/lib/run-timeline.test.ts`

Expected: 3 个测试全部 PASS。

- [ ] **Step 5: 写时间线 API 的失败测试**

`apps/web/src/lib/admin-api.test.ts` 顶部导入改为：

```ts
import {
  adminErrorText,
  createModelPrice,
  getAdminMetricTimeseries,
  getAdminOverview,
  getAdminRunTimeline,
  isForbidden,
  listAdminAlertEvents,
  listAdminAlertRules,
  listAdminUsers,
  resetAdminSetting,
  sendAdminAlertTest,
  updateAdminAlertRule,
  updateModelPrice,
} from './admin-api';
```

在 `describe('admin-api', ...)` 的最后一个 `});` 之前追加：

```ts
  it('运行时间线路径参数做 URL 编码', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ nodes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await getAdminRunTimeline('r/1');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('/api/admin/runs/r%2F1/timeline');
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-api.test.ts`

Expected: FAIL，提示 `getAdminRunTimeline` 未导出。

- [ ] **Step 7: 实现时间线 API**

`apps/web/src/lib/admin-api.ts` 顶部类型导入在 `AdminRunDetailDto,` 之后增加一行：

```ts
  AdminRunTimelineDto,
```

在 `getAdminRun` 函数之后追加：

```ts
export function getAdminRunTimeline(id: string): Promise<AdminRunTimelineDto> {
  return request(`/api/admin/runs/${encodeURIComponent(id)}/timeline`);
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-api.test.ts`

Expected: 全部 PASS。

- [ ] **Step 9: 在任务排障页接入时间线**

修改 `apps/web/src/app/admin/tasks/page.tsx`。

类型导入替换为：

```ts
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
} from '@ai-office/shared';
```

API 与工具函数导入替换为：

```ts
import {
  adminErrorText,
  getAdminRun,
  getAdminRunTimeline,
  getAdminTask,
  isForbidden,
  listAdminTasks,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';
import { formatDuration } from '../../../components/chart-geometry';
import {
  timelineKindLabel,
  timelineStatusLabel,
  timelineStatusTone,
} from '../../../lib/run-timeline';
```

在 `const [run, setRun] = useState<AdminRunDetailDto | null>(null);` 之后增加：

```ts
  const [timeline, setTimeline] = useState<AdminRunTimelineDto | null>(null);
  const [traceCopied, setTraceCopied] = useState(false);
```

`openTask` 中的清理块：

```ts
    setDetail(null);
    setRun(null);
    setTaskLoading(true);
```

替换为：

```ts
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setTaskLoading(true);
```

`closeTask` 中的清理块：

```ts
    setDetail(null);
    setRun(null);
    setTaskLoading(false);
```

替换为：

```ts
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setTaskLoading(false);
```

`openRun` 整体替换为：

```tsx
  async function openRun(id: string) {
    const seq = ++runSeq.current;
    setError('');
    setTimeline(null);
    setTraceCopied(false);
    try {
      // 时间线失败不应拖垮运行详情：两者独立结算，谁成功就先展示谁。
      const [runResult, timelineResult] = await Promise.allSettled([
        getAdminRun(id, { stepPage: 1, stepPageSize: 100 }),
        getAdminRunTimeline(id),
      ]);
      if (seq !== runSeq.current) return;
      if (runResult.status === 'rejected') {
        handleErr(runResult.reason);
        return;
      }
      setRun(runResult.value);
      if (timelineResult.status === 'fulfilled') {
        setTimeline(timelineResult.value);
      } else {
        handleErr(timelineResult.reason);
      }
    } catch (err) {
      if (seq !== runSeq.current) return;
      handleErr(err);
    }
  }

  // 复制失败（非 HTTPS、权限拒绝）时退回手动选择，不阻断时间线展示。
  async function copyTrace(traceId: string) {
    try {
      await navigator.clipboard.writeText(traceId);
      setTraceCopied(true);
    } catch {
      setError('复制失败，请手动选择 traceId');
    }
  }
```

在运行详情面板中，`<p className="admin-muted">状态 {run.status} …</p>` 之后、`{run.steps.items.length === 0 ? (` 之前插入：

```tsx
            {timeline && (
              <div className="run-timeline">
                <h3 className="billing-heading">时间线</h3>
                <p className="admin-muted">
                  {timeline.nodes.length} 个节点 · 用时 {formatDuration(timeline.durationMs)} ·
                  tokens {timeline.usage.inputTokens}/{timeline.usage.outputTokens} · 积分{' '}
                  {timeline.usage.credits ?? '—'}
                </p>
                <p className="admin-muted timeline-trace">
                  trace {timeline.traceId ?? '—'}
                  {timeline.traceId && (
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => {
                        if (timeline.traceId) void copyTrace(timeline.traceId);
                      }}
                    >
                      {traceCopied ? '已复制' : '复制 traceId'}
                    </button>
                  )}
                </p>
                <ol className="timeline-list">
                  {timeline.nodes.map((node) => {
                    const tone = timelineStatusTone(node.status);
                    return (
                      <li key={node.id} className="timeline-node">
                        <span className={`timeline-dot ${tone}`} aria-hidden="true" />
                        <div className="timeline-body">
                          <div className="timeline-head">
                            <span className="timeline-label">{node.label}</span>
                            <span className={`timeline-badge ${tone}`}>
                              {timelineStatusLabel(node.status)}
                            </span>
                            <span className="admin-muted">
                              {new Date(node.startedAt).toLocaleTimeString('zh-CN', {
                                hour12: false,
                              })}
                            </span>
                            {node.durationMs !== null && (
                              <span className="admin-muted">
                                {formatDuration(node.durationMs)}
                              </span>
                            )}
                          </div>
                          <div className="admin-muted">{timelineKindLabel(node.kind)}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {timeline.truncated && (
                  <p className="admin-muted">节点过多，已省略部分节点。</p>
                )}
              </div>
            )}
```

「关闭运行详情」按钮的回调：

```tsx
                runSeq.current += 1;
                setRun(null);
```

替换为：

```tsx
                runSeq.current += 1;
                setRun(null);
                setTimeline(null);
                setTraceCopied(false);
```

- [ ] **Step 10: 补时间线样式**

`apps/web/src/app/globals.css` 末尾追加（沿用既有 token，不引入新色值）：

```css
/* ================================ 运行时间线 ================================ */

.run-timeline {
  margin-top: 16px;
}

.timeline-list {
  position: relative;
  margin: 8px 0 12px;
  padding: 0 0 0 18px;
  list-style: none;
  border-left: 1px solid var(--line-strong);
}

.timeline-node {
  position: relative;
  padding: 0 0 12px 14px;
}

.timeline-dot {
  position: absolute;
  left: -23px;
  top: 6px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ink-3);
  border: 2px solid var(--surface);
}

.timeline-dot.ok {
  background: var(--mint);
}

.timeline-dot.bad {
  background: var(--danger);
}

.timeline-dot.warn {
  background: var(--amber-ink);
}

.timeline-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.timeline-trace {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-label {
  font-weight: 500;
}

.timeline-badge {
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--ink-2);
  background: var(--surface-2);
}

.timeline-badge.ok {
  color: var(--mint-ink);
  background: var(--mint-soft);
}

.timeline-badge.bad {
  color: var(--danger);
  background: var(--danger-soft);
}

.timeline-badge.warn {
  color: var(--amber-ink);
  background: var(--amber-soft);
}
```

> `.timeline-dot.active`、`.timeline-badge.active` 不单独写样式，沿用基类的墨灰即可——运行中是一个短暂状态，没必要再引入一种颜色语义。

- [ ] **Step 11: 补环境变量样例**

在 `.env.example` 末尾追加：

```bash
# 可观测性（M5b-2）
# 日志级别 trace/debug/info/warn/error/fatal；生产建议 info
LOG_LEVEL=info
# 1 时启用 pino-pretty 彩色输出（仅本地开发）
LOG_PRETTY=0
# OTLP/HTTP 端点（如 http://127.0.0.1:4318）；留空则不导出 trace
OTEL_EXPORTER_OTLP_ENDPOINT=
# OTLP 请求头，逗号分隔 key=urlencoded-value，如 authorization=Bearer%20xxx
OTEL_EXPORTER_OTLP_HEADERS=
# trace 采样率 0–1
OTEL_TRACES_SAMPLER_ARG=1.0
# 指标聚合间隔（毫秒，最小 10000；0 关闭定时任务）
METRICS_ROLLUP_MS=300000
# 首次启动回填小时数（1–168）
METRICS_BACKFILL_HOURS=24
# 指标桶保留天数（1–3650）
METRICS_RETENTION_DAYS=90
# 告警历史保留天数（1–3650）
ALERT_RETENTION_DAYS=90
# 告警评估总开关（也可在管理端参数页修改）
ALERTS_ENABLED=true
# 告警评估间隔（毫秒，最小 5000；0 关闭评估）
ALERT_EVAL_MS=60000
# Webhook 每小时投递上限
ALERT_MAX_PER_HOUR=60
# 告警 Webhook 初始配置；管理端参数页写入的 DB 值优先
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_SECRET=
# 告警消息中的管理端地址
ADMIN_WEB_URL=http://localhost:3000
```

- [ ] **Step 12: 把变量透传给 turbo 任务**

`turbo.json` 的 `globalPassThroughEnv` 数组尾部：

```json
    "MCP_INIT_TIMEOUT_MS",
    "MCP_CALL_TIMEOUT_MS"
  ],
```

替换为：

```json
    "MCP_INIT_TIMEOUT_MS",
    "MCP_CALL_TIMEOUT_MS",
    "LOG_LEVEL",
    "LOG_PRETTY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_TRACES_SAMPLER_ARG",
    "METRICS_ROLLUP_MS",
    "METRICS_BACKFILL_HOURS",
    "METRICS_RETENTION_DAYS",
    "ALERT_RETENTION_DAYS",
    "ALERTS_ENABLED",
    "ALERT_EVAL_MS",
    "ALERT_MAX_PER_HOUR",
    "ALERT_WEBHOOK_URL",
    "ALERT_WEBHOOK_SECRET",
    "ADMIN_WEB_URL",
    "APP_VERSION"
  ],
```

- [ ] **Step 13: 更新部署文档**

修改 `docs/deploy/06-deployment.md`。

文件头替换为：

```markdown
- 版本：v1.2
- 日期：2026-10-20
- 状态：随 M5b-2 可观测性交付更新
```

顶部说明中的待办改为：

```markdown
> 本文覆盖**本地开发**与**生产部署**两套流程。当前代码已具备生产级安全边界，但生产化项（密钥托管、队列、CI/CD）见 §10 与开发计划 §6。
```

§3 环境变量表在 `MCP_CALL_TIMEOUT_MS` 行之后追加：

```markdown
| `LOG_LEVEL` | `info` | 日志级别；生产保持 `info`，排障临时调 `debug` |
| `LOG_PRETTY` | `0` | 本地开发设 `1`；生产关闭，避免彩色转义符进入日志采集 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空 | OTLP/HTTP 端点（如 `http://collector:4318`）；留空不导出 trace |
| `OTEL_EXPORTER_OTLP_HEADERS` | 空 | OTLP 请求头，逗号分隔 `key=urlencoded-value` |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | trace 采样率 0–1；高流量环境下调以控成本 |
| `METRICS_ROLLUP_MS` | `300000` | 指标聚合间隔，最小 10000；`0` 关闭定时任务；多实例由 Leader 锁保证只跑一个 |
| `METRICS_BACKFILL_HOURS` | `24` | 启动时回填小时数，1–168 |
| `METRICS_RETENTION_DAYS` | `90` | 指标桶保留天数，1–3650；到期由聚合任务分批清理 |
| `ALERT_RETENTION_DAYS` | `90` | 告警事件保留天数，1–3650；到期由聚合任务分批清理 |
| `ALERTS_ENABLED` | `true` | 告警评估总开关；也可在管理端参数页修改（DB 优先） |
| `ALERT_EVAL_MS` | `60000` | 评估间隔，最小 5000；`0` 关闭评估但仍会播种规则 |
| `ALERT_MAX_PER_HOUR` | `60` | Webhook 滚动一小时投递上限（含测试告警） |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_SECRET` | 空 | 初始 Webhook 配置；管理端写入的 DB 值优先，secret 仅以掩码展示 |
| `ADMIN_WEB_URL` | `http://localhost:3000` | 告警消息中的管理端跳转地址 |
```

§7「健康检查与探活」整节替换为：

```markdown
## 7. 健康检查与探活

| 单元 | 端点 | 鉴权 | 期望 |
|---|---|---|---|
| agent-runtime | `GET /health` | 无 | `200 {"ok":true}` |
| agent-runtime | `GET /metrics`、`GET /metrics/summary` | 回环或 `x-agent-runtime-token` | 前者 Prometheus 文本，后者 JSON 摘要 |
| bff | `GET /api/health` | 无 | `200 {"status":"ok","version":"…"}`，仅证明进程存活 |
| bff | `GET /api/health/ready` | 回环或 `x-internal-token` | DB/Redis/runtime 全部可用才 200；否则 503 且 `checks` 标出失败项 |
| bff | `GET /metrics` | 回环或 `x-internal-token` | Prometheus 文本 |
| web | `GET /` | 无 | 200 |

> 编排探针建议：liveness 打 `/api/health`，readiness 打 `/api/health/ready`（由内网探针携带 `x-internal-token`）。不要把 `/metrics` 或 `/api/health/ready` 暴露到公网。
```

§10.2 安全加固清单中三行替换为：

```markdown
- [ ] 补齐按 IP/全局滥用防护（RPM 限流与积分额度已在 M5a 落地；限流指标与告警已在 M5b-2 落地，P7）。
- [ ] 日志脱敏（M5b-2 已内置 redact 路径；新增业务日志仍需自查）。
- [ ] 为 BFF 的 `/api/health`、`/api/health/ready` 配置 liveness/readiness 探针（M5b-2 已提供）。
```

§12 风险表中 P7 行替换为：

```markdown
| 请求限流仅覆盖 RPM 与积分额度 | 限流指标与告警已随 M5b-2 落地；仍缺按 IP/全局滥用防护 | 开发计划 P7 |
```

文末「管理端（M5b-1）」小节之后追加：

```markdown
## 管理端（M5b-2 可观测性）

- 概览 `/admin/overview`：24h/7d/30d KPI、运行/Token/时长趋势、按模型堆叠积分、模型成本与三服务健康；60 秒静默刷新，标签页隐藏时暂停。
- 告警 `/admin/alerts`：规则就地编辑、事件状态筛选与分页、发送测试告警；测试与真实投递共用每小时配额。
- 时间线：任务页打开运行后自动加载，最多 500 个节点，超出时提示省略数量；不包含 prompt 与工具入参/结果正文。
- 所有管理端接口仍受 `JwtGuard + AdminGuard` 保护；写操作与审计同事务。

### 可观测数据流

1. 服务产生结构化日志/span/指标；日志经 redact 后输出，span 按 `OTEL_TRACES_SAMPLER_ARG` 采样并导出到 OTLP 端点。
2. BFF 定时把事件聚合进 `MetricBucket`（小时桶），概览、趋势与告警共用。
3. 告警评估读取服务健康、结算滞留、运行失败率/P95、模型错误率与积分窗口；条件满足时写 `AlertEvent`（`openKey` 唯一，避免重复触发），并按冷却时间投递 Webhook。
4. Webhook 请求带 `x-ai-office-signature: sha256=<HMAC-SHA256(body, secret)>`，5 秒超时、不跟随重定向、仅允许 http(s)，最多重试 3 次。
5. 条件恢复后自动写 resolved 事件；停用规则会在同一事务里关闭其未恢复事件。

投递失败只影响通知，不阻塞评估；事件与 `deliveryStatus/deliveryError` 保留在告警中心。

### 安全边界（生产必读）

- **禁止把 prompt、消息正文、工具入参/结果全文、Authorization、内部 token、API key、连接器 env、Webhook secret 写入日志或指标 label。**
- **指标 label 禁止 userId/tenantId/sessionId/runId**；管理端指标接口也不返回邮箱、消息内容、工具入参/结果。
- `/metrics`、`/api/health/ready` 仅回环或内部 token 可访问；runtime 指标端点仅在配置 `AGENT_RUNTIME_TOKEN` 后对非回环来源放行。
- Webhook URL 仅管理员可改；secret 设置后永不返回明文，读取一律掩码。
- 日志默认带 `traceId/spanId/requestId` 与脱敏后的 userId/tenantId，排障时优先用 `requestId` 串联，不要把业务正文补进日志。
- 指标与告警历史默认各保留 90 天，分别按 `METRICS_RETENTION_DAYS`、`ALERT_RETENTION_DAYS` 分批清理；需要长期留存时在 Prometheus/远端存储侧另行配置。
```

- [ ] **Step 14: 更新开发计划状态**

修改 `docs/develop/05-dev-plan.md`。

文件头替换为：

```markdown
- 版本：v1.1
- 日期：2026-10-20
- 状态：随 M5b-2 可观测性交付更新
```

「里程碑总览」的 M5 行替换为：

```markdown
| **M5 商业化** | 计费与网关（M5a）+ 可观测/队列（M5b）+ 支付与上线（M5c） | M5a ✅ / M5b-1 ✅ / M5b-2 ✅ 已交付 | 个人版可对外 |
```

§5.2 整段替换为：

```markdown
### 5.2 M5b 管理端 + 可观测 + 队列

- M5b-1 管理端：用户/会员/会话/任务/模型/参数/审计 ✅
- M5b-2 可观测 ✅：
  - 全链路 trace（OTel）与结构化日志（pino，敏感字段脱敏）。
  - BFF/runtime 指标端点与 HTTP/运行/模型/工具/结算/限流指标。
  - 指标小时桶与概览 API；`/admin/overview` 看板（KPI、趋势、按模型积分、健康）。
  - 告警规则/事件、HMAC Webhook 与测试投递；`/admin/alerts` 告警中心。
  - 运行时间线（只展示工具名/文件名/静态文案）与 `/metrics` 访问控制。
- M5b-3 队列：BullMQ/Redis 任务队列、任务排队与取消/重试、断点续跑（复用 `step` checkpoint）（后续）
```

§6 的 P7 行替换为：

```markdown
| P7 | 反滥用覆盖不足 | 滥用、成本失控 | RPM 限流与积分额度已在 M5a 落地，限流指标与告警已在 M5b-2 落地；剩余：按 IP/全局滥用防护（M5c） | M5c |
```

§7 排期表两行替换为：

```markdown
| 已投入 | M0–M5b-2 已完成（见 §2、§5.1–5.2） |
| 待投入 | M5b-3 队列 + M5c ≈6 人日（乐观估计：M5b-3 ≈2、M5c ≈4） |
```

- [ ] **Step 15: 跑 web 测试、全量测试与构建**

```bash
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web exec tsc --noEmit
pnpm test
pnpm build
```

Expected: 所有包测试 PASS；tsc 无输出；`pnpm build` 5/5 成功（shared、telemetry、bff、agent-runtime、web）。

- [ ] **Step 16: 手工端到端验收**

先按部署文档启动依赖与服务（Postgres/MinIO/Redis → runtime → bff → web），并确认 `demo@example.com` 已提权为管理员：

```bash
pnpm --filter @ai-office/bff admin:promote demo@example.com
```

另开终端获取管理员 token：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4000/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"demo@example.com","password":"demo-password"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")
```

验证指标与健康：

```bash
curl -s http://127.0.0.1:4000/api/health | head -c 200
curl -s http://127.0.0.1:4000/api/health/ready | head -c 400
curl -s http://127.0.0.1:4000/metrics | grep -E 'ai_office_(http_requests_total|active_runs|alerts_fired_total)'
curl -s http://127.0.0.1:4001/metrics | grep ai_office_active_runs
curl -s 'http://127.0.0.1:4001/metrics/summary?windowMinutes=15' | head -c 300
```

Expected: 健康端点返回 `ok/ready`；两个 `/metrics` 都能看到 `ai_office_` 指标；摘要 JSON 含 `windowMinutes` 与 `status`。（若设置了 `AGENT_RUNTIME_TOKEN`，runtime 的 curl 需加 `-H "x-agent-runtime-token: $AGENT_RUNTIME_TOKEN"`。）

验证管理端三个新接口：

```bash
curl -s 'http://127.0.0.1:4000/api/admin/overview?range=24h' \
  -H "authorization: Bearer $TOKEN" | head -c 500

RULE_ID=$(curl -s http://127.0.0.1:4000/api/admin/alert-rules \
  -H "authorization: Bearer $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0]?.id ?? ''))")
curl -s "http://127.0.0.1:4000/api/admin/alert-events?page=1&pageSize=5" \
  -H "authorization: Bearer $TOKEN" | head -c 400
curl -s -X POST "http://127.0.0.1:4000/api/admin/alert-rules/$RULE_ID/test" \
  -H "authorization: Bearer $TOKEN"

TASK_ID=$(curl -s 'http://127.0.0.1:4000/api/admin/tasks?page=1&pageSize=1' \
  -H "authorization: Bearer $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).items[0]?.id ?? ''))")
RUN_ID=$(curl -s "http://127.0.0.1:4000/api/admin/tasks/$TASK_ID" \
  -H "authorization: Bearer $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).runs[0]?.id ?? ''))")
curl -s "http://127.0.0.1:4000/api/admin/runs/$RUN_ID/timeline" \
  -H "authorization: Bearer $TOKEN" | head -c 600
```

Expected: 概览返回 `current/previous/series/modelCosts/serviceHealth`；测试投递返回 `deliveryStatus`（未配置 Webhook 时为 `skipped` + `webhook_not_configured`）；时间线返回 `nodes` 且序列化内容中不出现 prompt、工具入参与结果正文。

浏览器验收：

1. 管理员登录 → 侧栏「运行概览」：KPI、四张图、模型成本与健康正常渲染；切换 7 天/30 天数据刷新；切到其他标签页 1 分钟后回来不报错。
2. 「告警中心」：改阈值并保存；刷新页面值保留；停用规则后事件表中该规则的 firing 事件变为 resolved；点「发送测试」结果列更新。
3. 「任务与运行」：打开有 step 的任务 → 查看运行 → 时间线节点按时间排列，失败/拒绝节点颜色不同，traceId 可一键复制；关闭面板后重新打开无旧数据残留。
4. 普通用户登录：侧栏无「运行概览」；直接访问 `/admin/overview` 被重定向；`curl /api/admin/overview` 返回 403。

- [ ] **Step 17: 提交**

```bash
git add apps/web/src/lib/run-timeline.ts apps/web/src/lib/run-timeline.test.ts apps/web/src/lib/admin-api.ts apps/web/src/lib/admin-api.test.ts apps/web/src/app/admin/tasks/page.tsx apps/web/src/app/globals.css .env.example turbo.json docs/deploy/06-deployment.md docs/develop/05-dev-plan.md
git commit -m "feat: 补齐运行时间线、可观测配置与交付文档

任务页只有原始 step，排障时仍要自己在事件流里拼时序；部署文档也
缺少新增开关与指标抓取方式。现在按接口聚合结果渲染时间线（只含
工具名、文件名和静态文案），补齐环境变量、turbo 透传、健康/指标
端点说明与告警运维边界，让 M5b-2 可以按文档完成部署与验收。"
```

---
