import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import type { ChartSpec } from '@ai-office/shared';
import { buildChartOption } from './chart-option';

/**
 * 用 ECharts 的 SSR 渲染器验证配置真的能画出图元：
 * 只断言 option 结构不够，配置写错时 ECharts 会静默画一张空图，
 * 这也是工作台里「图表只有白框」最可能的成因。
 */
function renderSvg(spec: ChartSpec): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 480, height: 260 });
  try {
    chart.setOption(buildChartOption(spec));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

describe('buildChartOption 可渲染性', () => {
  it('柱状图渲染出柱形与坐标轴', () => {
    const svg = renderSvg({
      kind: 'bar',
      categories: ['一月', '二月'],
      series: [{ name: '收入', data: [10, 20] }],
    });
    expect(svg).toContain('<svg');
    expect(svg.match(/<path/g)?.length ?? 0).toBeGreaterThan(1);
  });

  it('折线图渲染出路径', () => {
    const svg = renderSvg({
      kind: 'line',
      categories: ['一月', '二月', '三月'],
      series: [{ name: '收入', data: [10, 20, 15] }],
    });
    expect(svg).toContain('<svg');
    expect(svg.match(/<path/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it('饼图渲染出扇区', () => {
    const svg = renderSvg({
      kind: 'pie',
      categories: ['A', 'B'],
      series: [{ name: '占比', data: [3, 7] }],
    });
    expect(svg).toContain('<svg');
    expect(svg.match(/<path/g)?.length ?? 0).toBeGreaterThan(1);
  });
});
