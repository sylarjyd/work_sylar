import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';

/**
 * 厂商 Base URL 的安全校验。
 *
 * 该地址会由服务端（运营端连通性测试、运行时模型调用）发起请求，属于 SSRF 面：
 * - 默认拒绝回环、内网、CGNAT 等私有地址，避免被用来探测内网；
 * - 链路本地（含云元数据 169.254.169.254）、未指定、组播地址永远拒绝，即使开启内网开关；
 * - 确有内网/本机部署需求时，由运维显式设置 MODEL_ALLOW_PRIVATE_BASE_URL=1。
 *
 * 写入时做 DNS 解析校验；运行期只做同步的字面量校验（数据库中的地址在写入时已校验过），
 * 避免每次运行都依赖 DNS，降低解析抖动对任务的影响。
 */

export const ALLOW_PRIVATE_ENV = 'MODEL_ALLOW_PRIVATE_BASE_URL';

export interface ProviderUrlOptions {
  env?: NodeJS.ProcessEnv;
  resolveHosts?: (hostname: string) => Promise<string[]>;
}

interface ParsedProviderUrl {
  url: string;
  host: string;
  address: string | null;
  allowPrivate: boolean;
}

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  'metadata',
]);

function allowPrivate(env: NodeJS.ProcessEnv): boolean {
  const value = (env[ALLOW_PRIVATE_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/** IPv4 私有/危险地址判定。always 返回 true 表示无论是否开启内网开关都拒绝。 */
function classifyV4(value: number, privateAllowed: boolean): 'ok' | 'blocked' {
  // 永远拒绝：未指定、链路本地（云元数据）、组播、保留段。
  if (
    inV4Range(value, '0.0.0.0', 8) ||
    inV4Range(value, '169.254.0.0', 16) ||
    inV4Range(value, '224.0.0.0', 4) ||
    inV4Range(value, '240.0.0.0', 4)
  ) {
    return 'blocked';
  }
  // 阿里云元数据地址落在 CGNAT 段，单独列出。
  if (inV4Range(value, '100.100.100.200', 32)) return 'blocked';
  if (privateAllowed) return 'ok';
  if (
    inV4Range(value, '10.0.0.0', 8) ||
    inV4Range(value, '127.0.0.0', 8) ||
    inV4Range(value, '172.16.0.0', 12) ||
    inV4Range(value, '192.168.0.0', 16) ||
    inV4Range(value, '100.64.0.0', 10)
  ) {
    return 'blocked';
  }
  return 'ok';
}

/** 把 IPv6 展开成 8 个 16 位分组；内嵌 IPv4 也支持。 */
function expandV6(ip: string): number[] | null {
  let value = ip.split('%')[0].toLowerCase();
  if (isIP(value) !== 6) return null;

  const embedded = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v4 = ipv4ToInt(embedded[2]);
    if (v4 === null) return null;
    value = `${embedded[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const [leftRaw, rightRaw, ...rest] = value.split('::');
  if (rest.length > 0) return null;
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if (rightRaw === undefined && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right].map((g) =>
    parseInt(g, 16),
  );
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function classifyV6(groups: number[], privateAllowed: boolean): 'ok' | 'blocked' {
  // IPv4-mapped：::ffff:a.b.c.d 按 IPv4 规则处理，避免绕过。
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const value = ((groups[6] << 16) | groups[7]) >>> 0;
    return classifyV4(value, privateAllowed);
  }
  // :: 未指定地址。
  if (groups.every((g) => g === 0)) return 'blocked';
  // fe80::/10 链路本地，永远拒绝。
  if ((groups[0] & 0xffc0) === 0xfe80) return 'blocked';
  // ff00::/8 组播，永远拒绝。
  if ((groups[0] & 0xff00) === 0xff00) return 'blocked';
  if (privateAllowed) return 'ok';
  // ::1 回环。
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'blocked';
  // fc00::/7 唯一本地地址。
  if ((groups[0] & 0xfe00) === 0xfc00) return 'blocked';
  return 'ok';
}

function classifyAddress(address: string, privateAllowed: boolean): 'ok' | 'blocked' {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return value === null ? 'blocked' : classifyV4(value, privateAllowed);
  }
  if (family === 6) {
    const groups = expandV6(address);
    return groups === null ? 'blocked' : classifyV6(groups, privateAllowed);
  }
  return 'blocked';
}

function parse(raw: unknown, env: NodeJS.ProcessEnv): ParsedProviderUrl {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_base_url');
  const url = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException('invalid_base_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('invalid_base_url');
  }
  // 不在地址里携带账号密码，避免出现难以审计的凭据。
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BadRequestException('invalid_base_url');
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const bareHost = host.replace(/^\[/, '').replace(/\]$/, '');
  const privateAllowed = allowPrivate(env);

  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!privateAllowed) throw new BadRequestException('provider_url_blocked');
    return { url, host, address: null, allowPrivate: privateAllowed };
  }
  if (METADATA_HOSTNAMES.has(bareHost)) {
    throw new BadRequestException('provider_url_blocked');
  }
  if (isIP(bareHost) !== 0) {
    if (classifyAddress(bareHost, privateAllowed) === 'blocked') {
      throw new BadRequestException('provider_url_blocked');
    }
    return { url, host, address: bareHost, allowPrivate: privateAllowed };
  }
  return { url, host, address: null, allowPrivate: privateAllowed };
}

/** 同步校验：只检查字面量地址，不做 DNS。用于运行期复核数据库中的地址。 */
export function assertProviderBaseUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return parse(raw, env).url;
}

/** 运行期是否允许使用该地址（非法或命中拒绝策略时为 false）。 */
export function isStoredProviderUrlAllowed(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    assertProviderBaseUrl(raw, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入/连通性测试时使用：在同步校验之后再解析域名，
 * 任何一个解析结果命中拒绝策略都拒绝，避免用自有域名指向内网绕过字面量检查。
 * 解析失败不拦（地址本身无法解析，请求也到不了内网），保持离线环境与测试可用。
 */
export async function validateProviderBaseUrl(
  raw: unknown,
  options: ProviderUrlOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const parsed = parse(raw, env);
  if (parsed.address !== null) return parsed.url;

  const resolve = options.resolveHosts ?? (async (hostname: string) =>
    (await lookup(hostname, { all: true })).map((entry) => entry.address));
  let addresses: string[];
  try {
    addresses = await resolve(parsed.host);
  } catch {
    return parsed.url;
  }
  if (addresses.some((address) => classifyAddress(address, parsed.allowPrivate) === 'blocked')) {
    throw new BadRequestException('provider_url_blocked');
  }
  return parsed.url;
}
