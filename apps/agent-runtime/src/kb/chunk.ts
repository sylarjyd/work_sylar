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
 * 字符滑窗切分：窗口尾部若落在行中，就近回退到换行边界（不早于窗口一半）以少切碎行，再 trim。
 * 下一窗口起点以真实 end 为锚（end - overlap），故换行回退超过 overlap 时不会漏字；
 * overlap≥size 时用 max(start+1, …) 兜底为 1，避免死循环。
 */
export function chunkText(raw: string, size = 800, overlap = 150): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary > start + Math.floor(size / 2)) end = boundary;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    // 关键：以真实 end 锚定下一窗口起点；固定步进会在换行回退处留下缝隙导致漏字。
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
