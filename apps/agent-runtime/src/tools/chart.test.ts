import { describe, expect, it } from 'vitest';
import { createChartTool } from './chart';

const tool = createChartTool();

describe('chart.render', () => {
  it('把合法参数归一化为图表规格', async () => {
    const out = (await tool.execute(
      {
        kind: 'bar',
        title: ' 月度收入 ',
        categories: ['一月', '二月'],
        series: [{ name: '收入', data: [10, 20] }],
        yName: '万元',
        stacked: true,
      },
      {} as never,
    )) as { ok: true; chart: Record<string, unknown> };

    expect(out.ok).toBe(true);
    expect(out.chart).toMatchObject({
      kind: 'bar',
      categories: ['一月', '二月'],
      series: [{ name: '收入', data: [10, 20] }],
      title: '月度收入',
      yName: '万元',
      stacked: true,
    });
  });

  it('结构非法时抛错，提示模型修正', async () => {
    await expect(tool.execute({ kind: 'radar', categories: ['a'], series: [] }, {} as never)).rejects.toThrow(
      /invalid_chart_spec/,
    );
  });

  it('对超长数据截断而不是整张图失败', async () => {
    const out = (await tool.execute(
      {
        kind: 'line',
        categories: Array.from({ length: 300 }, (_, i) => `c${i}`),
        series: [{ name: 's', data: Array.from({ length: 300 }, () => 1) }],
      },
      {} as never,
    )) as { chart: { categories: unknown[]; series: Array<{ data: unknown[] }> } };

    expect(out.chart.categories).toHaveLength(200);
    expect(out.chart.series[0].data).toHaveLength(200);
  });
});
