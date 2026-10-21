/**
 * 把底层错误转成可展示的中文文案。
 * 业务错误码形如 `connectors_failed_403`、`stream_failed_500: ...`；
 * 无法识别的错误保留原文，便于排查。
 */
export function errorText(err: unknown): string {
  if (err instanceof TypeError) return '网络请求失败，请确认服务已启动后重试';
  const msg = err instanceof Error ? err.message : String(err);
  const status = msg.match(/_(4\d\d|5\d\d)(?:$|:)/)?.[1];
  if (status) {
    if (status === '401') return '登录已过期，请重新登录';
    if (status === '403') return '没有权限执行该操作';
    if (status === '404') return '请求的资源不存在';
    if (status === '413') return '文件过大，请压缩后重试';
    if (status.startsWith('4')) return '请求无效，请检查输入后重试';
    if (status.startsWith('5')) return '服务暂时不可用，请稍后重试';
  }
  return msg;
}
