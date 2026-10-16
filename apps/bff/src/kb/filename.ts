/**
 * 净化上传文件名，用作对象存储 key 的最后一段。
 * 剥离目录成分（防 ../ 逃逸），仅保留字母/数字/._-（保留中文等 Unicode 字母），
 * 保留扩展名；空名或纯点名回退 fallback，避免生成非法 key。
 */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
  return cleaned || fallback;
}
