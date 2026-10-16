import { describe, it, expect } from 'vitest';
import { fetchConnectors } from './bff-connector-client';

describe('fetchConnectors', () => {
  it('GET 到内部端点，带鉴权头与超时，返回连接器数组', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify([{ id: 'c1', name: 'echo', command: 'node', args: [], env: {}, enabled: true }]), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await fetchConnectors({ baseUrl: 'http://bff', internalToken: 'tok', fetchImpl }, 't1');
    expect(seenUrl).toBe('http://bff/internal/connectors?tenantId=t1');
    expect((seenInit?.headers as Record<string, string>)['x-internal-token']).toBe('tok');
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(out).toHaveLength(1);
  });

  it('tenantId 做 URL 编码', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await fetchConnectors({ baseUrl: 'http://bff', fetchImpl }, 'a/b');
    expect(seenUrl).toBe('http://bff/internal/connectors?tenantId=a%2Fb');
  });

  it('非 2xx 抛 connectors_unreachable 并回收响应体', async () => {
    let canceled = false;
    const res = { ok: false, body: { cancel: async () => { canceled = true; } } } as unknown as Response;
    const fetchImpl = (async () => res) as unknown as typeof fetch;
    await expect(fetchConnectors({ baseUrl: 'http://bff', fetchImpl }, 't1')).rejects.toThrow('connectors_unreachable');
    expect(canceled).toBe(true);
  });
});
