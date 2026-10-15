import type { Tool } from './types';

const MAX_CHARS = 8000;

/** 极简 HTML→文本：去 script/style、去标签、压缩空白。M1 不引入解析库。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function createWebFetchTool(): Tool {
  return {
    name: 'web.fetch',
    description: '抓取指定 URL 的网页并返回其纯文本内容（已截断到上限）。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的完整 URL' } },
      required: ['url'],
    },
    async execute(args) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new Error('invalid_url');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch_http_${res.status}`);
      const text = htmlToText(await res.text());
      return { url, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
    },
  };
}
