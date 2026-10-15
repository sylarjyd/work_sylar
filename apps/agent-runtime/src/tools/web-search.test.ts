import { describe, it, expect } from 'vitest';
import { createWebSearchTool, createSearchProvider, type SearchProvider } from './web-search';

const stub: SearchProvider = {
  async search(query) {
    return [{ title: `R:${query}`, url: 'https://e.com', snippet: 's' }];
  },
};

describe('createWebSearchTool', () => {
  it('把 query 传给 provider 并返回结果', async () => {
    const tool = createWebSearchTool(stub);
    expect(tool.name).toBe('web.search');
    const out = (await tool.execute({ query: '竞品' })) as { results: { title: string }[] };
    expect(out.results[0].title).toBe('R:竞品');
  });

  it('缺少 query 报错', async () => {
    const tool = createWebSearchTool(stub);
    await expect(tool.execute({})).rejects.toThrow('missing_query');
  });
});

describe('createSearchProvider', () => {
  it('有 TAVILY_API_KEY 与否都返回带 search 的 provider（不触发网络）', () => {
    expect(typeof createSearchProvider({ TAVILY_API_KEY: 'k' }).search).toBe('function');
    expect(typeof createSearchProvider({}).search).toBe('function');
  });
});
