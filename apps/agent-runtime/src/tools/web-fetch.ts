import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { Tool } from './types';

const MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 15_000;

/** 解析主机名的**全部** A/AAAA 记录：只查一条会漏掉多记录里混入的内网地址。 */
export type Resolver = (hostname: string) => Promise<string[]>;

/** 发一次 GET 并返回状态与响应体（不跟随跳转）；可注入以在单测中替代真实网络。 */
export type Transport = (
  url: URL,
  ip: string,
  timeoutMs: number,
) => Promise<{ status: number; body: string }>;

/** 拒绝环回/私网/链路本地/ULA/保留等非公网地址，封堵 SSRF（云元数据、内网服务）。 */
export function isBlockedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (isIP(v) === 4) {
    const [a, b, c] = v.split('.').map(Number);
    return (
      a === 0 || // 本网 0.0.0.0/8
      a === 10 || // 私网
      a === 127 || // 环回
      (a === 169 && b === 254) || // 链路本地（含云元数据 169.254.169.254）
      (a === 172 && b >= 16 && b <= 31) || // 私网
      (a === 192 && b === 168) || // 私网
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      (a === 198 && (b === 18 || b === 19)) || // 基准测试 198.18/15
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24、TEST-NET-1
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3
      a >= 224 // 组播 224/4 与保留 240/4
    );
  }
  if (isIP(v) === 6) {
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:')) return true; // link-local
    if (v.startsWith('fec0:')) return true; // site-local（已弃用）
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    if (v.startsWith('ff')) return true; // 组播
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4-mapped
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // 非 IP：解析异常，保守拒绝
}

const defaultResolve: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

/**
 * 把 socket 连接固定在**已校验**的 IP 上。node 的 lookup 是连接前唯一的解析路径，
 * 固定它即可杜绝“校验用一次解析、连接再解析一次”的 DNS rebinding TOCTOU——
 * 校验的地址与实际连接的地址同源。TLS 的 SNI 与证书校验仍按原 hostname（由 url 推导）。
 *
 * 兼容 node 的三种调用形式：http(s) 连接会以 (host, {all:true}, cb) 调用、要求回带
 * 地址数组；其余路径可能用 (host, {…}, cb) 或 (host, cb)，要求回带单个地址。
 */
export function pinnedLookup(ip: string, family: 4 | 6 = isIP(ip) === 6 ? 6 : 4) {
  return (hostname: string, optionsOrCb: unknown, maybeCb?: unknown): void => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (
      err: NodeJS.ErrnoException | null,
      address: unknown,
    ) => void;
    const all =
      typeof optionsOrCb === 'object' &&
      optionsOrCb !== null &&
      (optionsOrCb as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: ip, family }]);
    else cb(null, ip);
  };
}

/** 默认传输：node:http(s) 发 GET，lookup 固定到已校验 IP（见 pinnedLookup），不跟随跳转。 */
export const requestPinned: Transport = (url, ip, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { lookup: pinnedLookup(ip) as never, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume(); // 不跟随跳转：丢弃响应体，状态交由调用方判为 redirect_blocked
          resolve({ status, body: '' });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('fetch_timeout')));
    req.on('error', reject);
    req.end();
  });

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
 * 防护：发起前解析主机名的**全部**地址，只要有一条非公网即拒绝；随后把连接固定到
 * 已校验 IP（pinnedLookup），使校验与连接同源，杜绝 DNS rebinding；且不跟随跳转。
 * resolver / transport 可注入：单测用替身替代真实 DNS 与网络，保持离线可跑。
 */
export function createWebFetchTool(
  resolve: Resolver = defaultResolve,
  transport: Transport = requestPinned,
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
      const addrs = await resolve(url.hostname);
      if (addrs.length === 0 || addrs.some(isBlockedIp)) throw new Error('blocked_host');
      const { status, body } = await transport(url, addrs[0], FETCH_TIMEOUT_MS);
      if (status >= 300 && status < 400) throw new Error('redirect_blocked');
      if (status < 200 || status >= 300) throw new Error(`fetch_http_${status}`);
      const text = htmlToText(body);
      return { url: raw, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
    },
  };
}
