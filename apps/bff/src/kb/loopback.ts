/**
 * 判断请求来源是否为回环地址。内部端点未配置 INTERNAL_TOKEN 时只放行本机
 * （runtime 与 bff 同机部署），避免 bff 绑定 0.0.0.0 时被远程跨租户读取。
 */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  // 双栈 socket 上 Node 把 IPv4 呈现为 ::ffff:127.0.0.1。
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return addr === '::1' || addr.startsWith('127.');
}
