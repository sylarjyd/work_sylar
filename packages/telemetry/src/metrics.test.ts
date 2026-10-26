import { describe, expect, it } from 'vitest';
import { Counter } from 'prom-client';
import {
  boundedLabel,
  createMetricsRegistry,
  HTTP_DURATION_BUCKETS,
  RUN_QUEUE_WAIT_BUCKETS,
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

  it('队列等待桶以秒为单位，覆盖 10 分钟长等待', () => {
    expect(RUN_QUEUE_WAIT_BUCKETS).toEqual([1, 5, 15, 30, 60, 120, 300, 600]);
  });
});
