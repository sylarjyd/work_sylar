import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk';

describe('chunkText', () => {
  it('空/纯空白文本返回空数组', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('短文本单块返回（归一化后）', () => {
    expect(chunkText('  hello   world  ')).toEqual(['hello world']);
  });

  it('长文本切多块，每块不超过 size', () => {
    const text = '句子。'.repeat(1000); // 3000 字
    const chunks = chunkText(text, 800, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
  });

  it('覆盖全文首尾', () => {
    const text = Array.from({ length: 200 }, (_, i) => `第${i}行内容`).join('\n');
    const chunks = chunkText(text, 300, 60);
    expect(chunks[0].startsWith(text.slice(0, 5))).toBe(true);
    expect(chunks[chunks.length - 1].endsWith(text.slice(-5))).toBe(true);
  });

  it('优先在换行边界断开（窗口后半段有换行则不切碎行）', () => {
    const head = 'x'.repeat(500);
    const text = `${head}\n${'y'.repeat(500)}`;
    const chunks = chunkText(text, 600, 100);
    expect(chunks[0].endsWith('x')).toBe(true);
    expect(chunks[0].includes('y')).toBe(false);
  });

  it('overlap≥size 时不死循环（步进兜底为 1）', () => {
    const chunks = chunkText('abcdefg'.repeat(50), 10, 999);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
