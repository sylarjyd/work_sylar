/** 归一化：统一换行、压缩行内空白、去掉多余空行并 trim 两端。 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 字符滑窗切分：步进 = size - overlap；窗口尾部若落在行中，就近回退到换行边界
 * （不早于窗口一半）以少切碎行，再 trim。overlap≥size 时步进兜底为 1，避免死循环。
 */
export function chunkText(raw: string, size = 800, overlap = 150): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary > start + Math.floor(size / 2)) end = boundary;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
  }
  return chunks;
}
