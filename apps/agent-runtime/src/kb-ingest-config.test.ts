import { describe, it, expect } from 'vitest';
import { resolveChunkConfig } from './server';

describe('resolveChunkConfig', () => {
  it('请求值优先', () => {
    expect(resolveChunkConfig({ chunkSize: 600, chunkOverlap: 100 }, {})).toEqual({
      chunkSize: 600,
      chunkOverlap: 100,
    });
  });

  it('越界值回落到 env', () => {
    expect(
      resolveChunkConfig(
        { chunkSize: 10, chunkOverlap: -1 },
        { KB_CHUNK_SIZE: '700', KB_CHUNK_OVERLAP: '50' },
      ),
    ).toEqual({ chunkSize: 700, chunkOverlap: 50 });
  });

  it('overlap ≥ size 时回落到安全值', () => {
    expect(resolveChunkConfig({ chunkSize: 100, chunkOverlap: 100 }, {})).toEqual({
      chunkSize: 100,
      chunkOverlap: 99,
    });
  });

  it('请求值非数字时忽略并回落到 env', () => {
    expect(
      resolveChunkConfig(
        { chunkSize: '600', chunkOverlap: '100' },
        { KB_CHUNK_SIZE: '700', KB_CHUNK_OVERLAP: '50' },
      ),
    ).toEqual({ chunkSize: 700, chunkOverlap: 50 });
  });

  it('非整数/负数的 size 回落到默认 800', () => {
    expect(resolveChunkConfig({ chunkSize: 100.5 }, {})).toEqual({ chunkSize: 800, chunkOverlap: 150 });
    expect(resolveChunkConfig({ chunkSize: -1 }, {})).toEqual({ chunkSize: 800, chunkOverlap: 150 });
  });

  it('空/空白 env 视为未设置', () => {
    expect(
      resolveChunkConfig({}, { KB_CHUNK_SIZE: '', KB_CHUNK_OVERLAP: '  ' }),
    ).toEqual({ chunkSize: 800, chunkOverlap: 150 });
  });

  it('全缺省时用 800/150', () => {
    expect(resolveChunkConfig({}, {})).toEqual({ chunkSize: 800, chunkOverlap: 150 });
  });
});
