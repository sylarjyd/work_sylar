import { describe, it, expect } from 'vitest';
import { createKbRetrieveTool } from './kb-retrieve';
import type { EmbeddingGateway } from '../embedding/types';

const ctx = { tenantId: 't1', userId: 'u1', sessionId: 's1', runId: 'r1' };

const embed: EmbeddingGateway = {
  dim: 2,
  async embed(texts) {
    return texts.map(() => [1, 0]);
  },
};

function toolWith(fetchImpl: typeof fetch) {
  return createKbRetrieveTool({ baseUrl: 'http://bff', internalToken: 'tok', embed, fetchImpl });
}

describe('kb.retrieve', () => {
  it('元数据：safe 权限与参数 schema', () => {
    const t = toolWith(fetch);
    expect(t.name).toBe('kb.retrieve');
    expect(t.permission).toBe('safe');
    expect(t.parameters).toMatchObject({ type: 'object', required: ['query'] });
  });

  it('命中：返回引用正文 + display.sources（不再被 500 字截断前的结构）', async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ topK: 5, tenantId: 't1', userId: 'u1' });
      expect(body.vector).toEqual([1, 0]);
      return new Response(
        JSON.stringify([
          { docName: '报告.docx', seq: 3, score: 0.82, text: '第一段内容' },
          { docName: '笔记.md', seq: 0, score: 0.71, text: '第二段内容' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const out = (await toolWith(fetchImpl).execute({ query: '问题' }, ctx)) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(String(out.text)).toContain('[来源: 报告.docx#3]');
    expect(out.display).toEqual({
      sources: [
        { docName: '报告.docx', seq: 3, score: 0.82, snippet: '第一段内容' },
        { docName: '笔记.md', seq: 0, score: 0.71, snippet: '第二段内容' },
      ],
    });
  });

  it('topK clamp 到 [1,20]', async () => {
    let seen = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body)).topK;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await toolWith(fetchImpl).execute({ query: 'x', topK: 999 }, ctx);
    expect(seen).toBe(20);
    await toolWith(fetchImpl).execute({ query: 'x', topK: 0 }, ctx);
    expect(seen).toBe(1);
  });

  it('无命中：text 提示、sources 为空', async () => {
    const fetchImpl = (async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const out = (await toolWith(fetchImpl).execute({ query: 'x' }, ctx)) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.text).toBe('知识库无匹配内容');
    expect(out.display).toEqual({ sources: [] });
  });

  it('BFF 不可达：返回结构化失败，不抛异常', async () => {
    const fetchImpl = (async () => {
      throw new Error('econnrefused');
    }) as unknown as typeof fetch;
    const out = (await toolWith(fetchImpl).execute({ query: 'x' }, ctx)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('kb_search_unreachable');
    expect(out.display).toEqual({ sources: [] });
  });

  it('BFF 非 2xx：同样返回 kb_search_unreachable', async () => {
    const fetchImpl = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const out = (await toolWith(fetchImpl).execute({ query: 'x' }, ctx)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('kb_search_unreachable');
  });

  it('BFF 返回 200 但非数组：收敛为 kb_search_unreachable，不抛异常', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const out = (await toolWith(fetchImpl).execute({ query: 'x' }, ctx)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('kb_search_unreachable');
    expect(out.display).toEqual({ sources: [] });
  });

  it('嵌入返回空数组：不发出无向量请求，收敛为 kb_search_unreachable', async () => {
    const emptyEmbed: EmbeddingGateway = {
      dim: 2,
      async embed() {
        return [];
      },
    };
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const t = createKbRetrieveTool({ baseUrl: 'http://bff', internalToken: 'tok', embed: emptyEmbed, fetchImpl });
    const out = (await t.execute({ query: 'x' }, ctx)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('kb_search_unreachable');
    expect(called).toBe(false);
  });
});
