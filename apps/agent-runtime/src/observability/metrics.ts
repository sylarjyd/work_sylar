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
