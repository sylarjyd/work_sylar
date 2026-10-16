import { describe, it, expect } from 'vitest';
import { ingest } from './ingest';
import type { EmbeddingGateway } from '../embedding/types';

const fakeEmbed: EmbeddingGateway = {
  dim: 3,
  async embed(texts) {
    return texts.map((t) => [t.length, 0, 0]);
  },
};

describe('ingest', () => {
  it('解析→切分→嵌入，seq 从 0 连续、向量与切片对齐', async () => {
    const text = '甲'.repeat(2000);
    const chunks = await ingest(
      { data: Buffer.from(text, 'utf8'), filename: 'a.txt' },
      { embed: fakeEmbed },
      { chunkSize: 800, chunkOverlap: 150 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    // 向量 = [切片长度, 0, 0]：与文本长度对齐即为正确配对。
    chunks.forEach((c) => expect(c.vector).toEqual([c.text.length, 0, 0]));
  });

  it('空文档抛 empty_document', async () => {
    await expect(
      ingest({ data: Buffer.from('   ', 'utf8'), filename: 'a.txt' }, { embed: fakeEmbed }),
    ).rejects.toThrow('empty_document');
  });

  it('不支持类型原样冒泡 unsupported_type', async () => {
    await expect(
      ingest({ data: Buffer.from('x'), filename: 'a.exe' }, { embed: fakeEmbed }),
    ).rejects.toThrow('unsupported_type');
  });

  it('嵌入返回行数不足时抛 embed_count_mismatch', async () => {
    const partial: EmbeddingGateway = {
      dim: 3,
      async embed(texts) {
        return texts.slice(0, texts.length - 1).map((t) => [t.length, 0, 0]);
      },
    };
    await expect(
      ingest({ data: Buffer.from('甲'.repeat(2000), 'utf8'), filename: 'a.txt' }, { embed: partial }),
    ).rejects.toThrow('embed_count_mismatch');
  });
});
