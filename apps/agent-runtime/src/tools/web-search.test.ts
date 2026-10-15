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
  it('有无 TAVILY_API_KEY 都返回可挂载为工具的 provider（不触发网络）', () => {
    for (const env of [{ TAVILY_API_KEY: 'k' }, {}] as NodeJS.ProcessEnv[]) {
      const provider = createSearchProvider(env);
      expect(typeof provider.search).toBe('function');
      const tool = createWebSearchTool(provider);
      expect(tool.name).toBe('web.search');
      expect(typeof tool.execute).toBe('function');
    }
  });
});
