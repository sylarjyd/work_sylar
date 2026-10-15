import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Tool } from './types';

const MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 15_000;

export type Resolver = (hostname: string) => Promise<string>;

/** 拒绝环回/私网/链路本地/ULA 等非公网地址，封堵 SSRF（云元数据、内网服务）。 */
export function isBlockedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(v) === 6) {
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4-mapped
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // 非 IP：解析异常，保守拒绝
}

const defaultResolve: Resolver = async (hostname) => (await lookup(hostname)).address;

/** 极简 HTML→文本：去 script/style、去标签、压缩空白。M1 不引入解析库。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // &amp; 最后解码：否则 `&amp;lt;` 会先被还原成 `&lt;`，再被下面的规则误当成 `<`。
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * web.fetch 的 URL 由模型生成、可被目标网页或用户目标间接影响，属 SSRF 攻击面：
 * 攻击者可诱使 Agent 抓取云元数据（169.254.169.254）或内网服务，再把响应读回对话。
 * 因此在发起请求前解析主机名并拒绝非公网地址，且不自动跟随跳转（避免 3xx 绕过校验）。
 * resolver 可注入：单测用它替代真实 DNS，保持离线可跑。
 */
export function createWebFetchTool(
  fetcher: typeof fetch = fetch,
  resolve: Resolver = defaultResolve,
): Tool {
  return {
    name: 'web.fetch',
    description: '抓取指定 URL 的网页并返回其纯文本内容（已截断到上限）。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的完整 URL' } },
      required: ['url'],
    },
    async execute(args) {
      const raw = String(args.url ?? '');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error('invalid_url');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_url');
      if (isBlockedIp(await resolve(url.hostname))) throw new Error('blocked_host');
      const res = await fetcher(raw, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // 不自动跟随跳转：否则重定向可绕过上面的 host 校验。
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) throw new Error('redirect_blocked');
      if (!res.ok) throw new Error(`fetch_http_${res.status}`);
      const text = htmlToText(await res.text());
      return { url: raw, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
    },
  };
}
