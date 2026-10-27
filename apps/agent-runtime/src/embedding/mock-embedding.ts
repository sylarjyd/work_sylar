import type { EmbeddingGateway } from './types';

/** 词袋哈希：非空文本返回 1024 维单位向量，使词面重叠驱动余弦相似度（离线可验证管线）。 */
export function hashEmbed(text: string, dim = 1024): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of tokenize(text)) {
    // 双哈希降碰撞：同一词落两处，仍由词面重叠主导相似度。
    v[hash(tok, 0x811c9dc5) % dim] += 1;
    v[hash(tok, 0x1000193) % dim] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** FNV-1a 变体，带种子。 */
function hash(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 按 Unicode 字母/数字切词，其余为分隔符；全小写。 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** 两向量余弦（任一为零向量则返回 0）。 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 无 key / 测试用的确定性嵌入。 */
export class MockEmbeddingGateway implements EmbeddingGateway {
  readonly dim: number;
  readonly model = 'mock';
  constructor(dim = 1024) {
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dim));
  }
}
