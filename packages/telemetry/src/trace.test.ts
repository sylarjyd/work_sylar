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
