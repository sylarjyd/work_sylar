import { describe, it, expect } from 'vitest';
import { searchKb } from './bff-client';

const params = { vector: [1, 0], topK: 5, tenantId: 't1', userId: 'u1' };

describe('searchKb', () => {
  it('成功：POST 到内部检索端点，带鉴权头与超时信号，返回命中数组', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify([{ docName: 'a.docx', seq: 1, score: 0.9, text: 't' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const hits = await searchKb({ baseUrl: 'http://bff', internalToken: 'tok', fetchImpl }, params);
    expect(seenUrl).toBe('http://bff/internal/kb/search');
    expect((seenInit?.headers as Record<string, string>)['x-internal-token']).toBe('tok');
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(hits).toHaveLength(1);
  });

  it('无 token 时不带鉴权头', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    await searchKb({ baseUrl: 'http://bff', fetchImpl }, params);
    expect(headers['x-internal-token']).toBeUndefined();
  });

  it('非 2xx：抛 kb_search_unreachable 并回收响应体', async () => {
    let canceled = false;
    const res = {
      ok: false,
      body: { cancel: async () => { canceled = true; } },
    } as unknown as Response;
    const fetchImpl = (async () => res) as unknown as typeof fetch;

    await expect(searchKb({ baseUrl: 'http://bff', fetchImpl }, params)).rejects.toThrow(
      'kb_search_unreachable',
    );
    expect(canceled).toBe(true);
  });
});
