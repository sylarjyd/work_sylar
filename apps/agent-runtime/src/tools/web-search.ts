import type { Tool } from './types';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

/** Tavily 优先（有 key），否则 DuckDuckGo 免 key 回退。 */
export function createSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  if (env.TAVILY_API_KEY) return tavilyProvider(env.TAVILY_API_KEY);
  return duckDuckGoProvider();
}

export function createWebSearchTool(provider: SearchProvider): Tool {
  return {
    name: 'web.search',
    description: '联网搜索，返回若干条 {title,url,snippet} 结果。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('missing_query');
      return { results: await provider.search(query) };
    },
  };
}

function tavilyProvider(apiKey: string): SearchProvider {
  return {
    async search(query) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
      });
      if (!res.ok) throw new Error(`tavily_http_${res.status}`);
      const data = (await res.json()) as { results?: SearchResult[] };
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet ?? '',
      }));
    },
  };
}

function duckDuckGoProvider(): SearchProvider {
  return {
    async search(query) {
      // 免 key 的 instant answer 接口：够 M1 演示用，质量不如 Tavily。
      const res = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      );
      if (!res.ok) throw new Error(`ddg_http_${res.status}`);
      const data = (await res.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: { Text?: string; FirstURL?: string }[];
      };
      const results: SearchResult[] = [];
      if (data.AbstractText && data.AbstractURL) {
        results.push({ title: query, url: data.AbstractURL, snippet: data.AbstractText });
      }
      for (const t of data.RelatedTopics ?? []) {
        if (t.Text && t.FirstURL) results.push({ title: t.Text, url: t.FirstURL, snippet: t.Text });
      }
      return results.slice(0, 5);
    },
  };
}
