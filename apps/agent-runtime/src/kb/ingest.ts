import type { EmbeddingGateway } from '../embedding/types';
import { parseDocument, type ParseDeps, type ParseInput } from './parse';
import { chunkText } from './chunk';

export interface IngestDeps extends ParseDeps {
  embed: EmbeddingGateway;
}

export interface IngestOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface IngestedChunk {
  seq: number;
  text: string;
  vector: number[];
}

/** 编排：解析出文本 → 切分 → 批量嵌入 → 组装带 seq 的切片。空文档视为失败。 */
export async function ingest(
  input: ParseInput,
  deps: IngestDeps,
  opts: IngestOptions = {},
): Promise<IngestedChunk[]> {
  const text = await parseDocument(input, deps);
  if (!text.trim()) throw new Error('empty_document');
  const pieces = chunkText(text, opts.chunkSize ?? 800, opts.chunkOverlap ?? 150);
  if (pieces.length === 0) throw new Error('empty_document');
  const vectors = await deps.embed.embed(pieces);
  if (vectors.length !== pieces.length) throw new Error('embed_count_mismatch');
  return pieces.map((t, i) => ({ seq: i, text: t, vector: vectors[i] }));
}
