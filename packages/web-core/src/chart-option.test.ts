import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '@ai-office/shared';
import { buildChartOption, CHART_PALETTE } from './chart-option';

const bar: ChartSpec = {
  kind: 'bar',
  categories: ['一月', '二月'],
  series: [{ name: '收入', data: [10, 20] }],
};

describe('buildChartOption', () => {
  it('柱状图：分类轴 + 数值轴 + tooltip', () => {
    const opt = buildChartOption(bar) as Record<string, any>;
    expect(opt.xAxis).toMatchObject({ type: 'category', data: ['一月', '二月'] });
    expect(opt.yAxis).toMatchObject({ type: 'value' });
    expect(opt.tooltip).toMatchObject({ trigger: 'axis' });
    expect(opt.series[0]).toMatchObject({ type: 'bar', name: '收入', data: [10, 20] });
    expect(opt.series[0].itemStyle.color).toBe(CHART_PALETTE[0]);
  });

  it('堆叠横向条形图：轴互换并带 stack', () => {
    const opt = buildChartOption({
      ...bar,
      stacked: true,
      horizontal: true,
      series: [
        { name: 'A', data: [1, 2] },
        { name: 'B', data: [3, 4] },
      ],
    }) as Record<string, any>;
    expect(opt.xAxis.type).toBe('value');
    expect(opt.yAxis.type).toBe('category');
    expect(opt.series[0].stack).toBe('total');
    expect(opt.legend).toBeDefined();
  });

  it('面积图用 line + areaStyle', () => {
    const opt = buildChartOption({ ...bar, kind: 'area' }) as Record<string, any>;
    expect(opt.series[0].type).toBe('line');
    expect(opt.series[0].areaStyle).toBeDefined();
  });

  it('饼图只画一个系列，扇区取分类名', () => {
    const opt = buildChartOption({
      kind: 'pie',
      categories: ['A', 'B'],
      series: [{ name: 's', data: [3, 7] }],
    }) as Record<string, any>;
    expect(opt.series).toHaveLength(1);
    expect(opt.series[0].type).toBe('pie');
    expect(opt.series[0].data).toEqual([
      { name: 'A', value: 3, itemStyle: { color: CHART_PALETTE[0] } },
      { name: 'B', value: 7, itemStyle: { color: CHART_PALETTE[1] } },
    ]);
  });

  it('分类很多时加缩放条并旋转标签', () => {
    const spec: ChartSpec = {
      kind: 'line',
      categories: Array.from({ length: 40 }, (_, i) => `第 ${i} 天`),
      series: [{ name: 's', data: Array.from({ length: 40 }, (_, i) => i) }],
    };
    const opt = buildChartOption(spec) as Record<string, any>;
    expect(opt.dataZoom).toHaveLength(2);
    expect(opt.xAxis.axisLabel.rotate).toBeGreaterThan(0);
  });

  it('无标题时不输出 title，单系列不输出 legend', () => {
    const opt = buildChartOption(bar) as Record<string, any>;
    expect(opt.title).toBeUndefined();
    expect(opt.legend).toBeUndefined();
  });
});
