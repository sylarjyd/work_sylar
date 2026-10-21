/**
 * 浏览器侧的追踪头：每次请求新建一条 trace，BFF 提取后继续派生 span。
 * 仅用于日志/追踪关联，不承载鉴权语义。
 */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    // 极老浏览器兜底：非加密随机，足够做关联 ID。
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** W3C 要求 traceId/spanId 非全零；随机碰撞概率极低，仍显式兜底。 */
function nonZeroHex(bytes: number): string {
  const value = randomHex(bytes);
  return /^0+$/.test(value) ? `1${value.slice(1)}` : value;
}

/** 版本 00、采样位 01：默认全采样，生产采样率由服务端 ParentBasedSampler 决定。 */
export function newTraceparent(): string {
  return `00-${nonZeroHex(16)}-${nonZeroHex(8)}-01`;
}

/** UUID（36 字符）或 32 位十六进制兜底；二者都落在 BFF 的长度与字符集约束内。 */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return randomHex(16);
}
