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
