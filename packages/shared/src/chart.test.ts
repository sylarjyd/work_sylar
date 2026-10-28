import { describe, expect, it } from 'vitest';
import { normalizeChartSpec } from './chart';

const base = {
  kind: 'bar',
  categories: ['一月', '二月'],
  series: [{ name: '收入', data: [10, 20] }],
};

describe('normalizeChartSpec', () => {
  it('保留合法规格与可选样式', () => {
    const spec = normalizeChartSpec({
      ...base,
      title: '  月度收入  ',
      yName: '万元',
      stacked: true,
      horizontal: true,
    });
    expect(spec).toEqual({
      kind: 'bar',
      categories: ['一月', '二月'],
      series: [{ name: '收入', data: [10, 20] }],
      title: '月度收入',
      yName: '万元',
      stacked: true,
      horizontal: true,
    });
  });

  it('非法 kind、缺分类、缺系列一律拒绝', () => {
    expect(normalizeChartSpec({ ...base, kind: 'radar' })).toBeNull();
    expect(normalizeChartSpec({ ...base, categories: [] })).toBeNull();
    expect(normalizeChartSpec({ ...base, series: [] })).toBeNull();
    expect(normalizeChartSpec(null)).toBeNull();
    expect(normalizeChartSpec('chart')).toBeNull();
  });

  it('数据按分类对齐：缺项补 null，非法数字转 null，多余项丢弃', () => {
    const spec = normalizeChartSpec({
      ...base,
      series: [{ name: '收入', data: [1, Number.NaN, 3] }],
    });
    expect(spec?.series[0].data).toEqual([1, null]);
  });

  it('超长分类与系列按上限截断', () => {
    const categories = Array.from({ length: 300 }, (_, i) => `c${i}`);
    const spec = normalizeChartSpec({
      kind: 'line',
      categories,
      series: Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, data: [1] })),
    });
    expect(spec?.categories).toHaveLength(200);
    expect(spec?.series).toHaveLength(8);
    expect(spec?.series[0].data).toHaveLength(200);
  });

  it('饼图至少两个扇区且只保留一个系列', () => {
    expect(
      normalizeChartSpec({ kind: 'pie', categories: ['A'], series: [{ name: 's', data: [1] }] }),
    ).toBeNull();
    const spec = normalizeChartSpec({
      kind: 'pie',
      categories: ['A', 'B'],
      series: [
        { name: 's1', data: [1, 2] },
        { name: 's2', data: [3, 4] },
      ],
    });
    expect(spec?.series).toHaveLength(1);
  });

  it('stacked/horizontal 只对适用类型生效', () => {
    expect(
      normalizeChartSpec({ ...base, kind: 'pie', categories: ['A', 'B'], stacked: true })
        ?.stacked,
    ).toBeUndefined();
    expect(normalizeChartSpec({ ...base, kind: 'line', horizontal: true })?.horizontal).toBeUndefined();
  });
});
