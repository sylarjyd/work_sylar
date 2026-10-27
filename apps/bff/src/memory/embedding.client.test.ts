import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingClient } from './embedding.client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EmbeddingClient', () => {
  it('调用 runtime /embed 并携带共享密钥', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ vectors: [[1, 0, 0]], dim: 3, model: 'm' }));
    const client = new EmbeddingClient({
      runtimeUrl: 'http://runtime/',
      runtimeToken: 'tok',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.embed(['你好'])).resolves.toEqual([[1, 0, 0]]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://runtime/embed');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-agent-runtime-token']).toBe('tok');
    expect(JSON.parse(String(init.body))).toEqual({ texts: ['你好'] });
  });

  it('条数或维度异常时抛错，交给调用方降级', async () => {
    const mismatch = new EmbeddingClient({
      runtimeUrl: 'http://runtime',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ vectors: [[1], [2]], dim: 1, model: 'm' }),
        ) as unknown as typeof fetch,
    });
    await expect(mismatch.embed(['a'])).rejects.toThrow('embed_count_mismatch');

    const invalid = new EmbeddingClient({
      runtimeUrl: 'http://runtime',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(jsonResponse({ vectors: [['x']], dim: 1, model: 'm' })) as unknown as typeof fetch,
    });
    await expect(invalid.embed(['a'])).rejects.toThrow('embed_invalid_vector');
  });

  it('非 2xx 抛 embed_http_<status>', async () => {
    const client = new EmbeddingClient({
      runtimeUrl: 'http://runtime',
      fetchImpl: vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(client.embed(['a'])).rejects.toThrow('embed_http_500');
  });

  it('空输入直接返回空数组；空串与超量在本地拒绝', async () => {
    const fetchMock = vi.fn();
    const client = new EmbeddingClient({
      runtimeUrl: 'http://runtime',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(client.embed([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(client.embed(['  '])).rejects.toThrow('embed_empty_text');
    await expect(
      client.embed(Array.from({ length: 65 }, () => 'x')),
    ).rejects.toThrow('embed_too_many_texts');
  });
});
