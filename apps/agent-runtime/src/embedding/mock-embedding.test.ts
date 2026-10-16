import { describe, it, expect } from 'vitest';
import { MockEmbeddingGateway, hashEmbed, cosine } from './mock-embedding';

describe('hashEmbed', () => {
  it('输出固定 1024 维', () => {
    expect(hashEmbed('苹果 香蕉').length).toBe(1024);
  });

  it('确定性：同文本两次结果完全一致', () => {
    expect(hashEmbed('重复文本 a b c')).toEqual(hashEmbed('重复文本 a b c'));
  });

  it('非空文本单位化（L2 范数≈1）', () => {
    const v = hashEmbed('some words here');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('空文本返回零向量', () => {
    const v = hashEmbed('');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('词面重叠驱动相似度：共享词越多越相似', () => {
    const query = hashEmbed('苹果 香蕉 价格');
    const hit = cosine(query, hashEmbed('苹果 香蕉 价格 行情'));
    const miss = cosine(query, hashEmbed('电脑 键盘 鼠标'));
    expect(hit).toBeGreaterThan(miss);
  });
});

describe('MockEmbeddingGateway', () => {
  it('按输入逐条嵌入，顺序与维度稳定', async () => {
    const gw = new MockEmbeddingGateway(1024);
    const out = await gw.embed(['甲', '乙 丙']);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual(hashEmbed('甲'));
    expect(out[1].length).toBe(1024);
  });
});
