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
