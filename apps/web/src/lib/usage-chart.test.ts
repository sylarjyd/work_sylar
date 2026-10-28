import { describe, expect, it } from 'vitest';
import type { UsageAggregateDto } from '@ai-office/shared';
import { buildUsageCharts } from './usage-chart';

const rows: UsageAggregateDto[] = [
  { key: '2026-10-01', credits: 12, inputTokens: 100, outputTokens: 40, runs: 2 },
  { key: '2026-10-02', credits: 8, inputTokens: 60, outputTokens: 20, runs: 1 },
];

describe('buildUsageCharts', () => {
  it('按日聚合：分类取日期，积分与 token 各成一张图', () => {
    const charts = buildUsageCharts(rows, 'day');
    expect(charts.credits).toMatchObject({
      kind: 'bar',
      categories: ['2026-10-01', '2026-10-02'],
      series: [{ name: '消耗积分', data: [12, 8] }],
    });
    expect(charts.credits.title).toContain('每日');
    expect(charts.tokens.series.map((s) => s.name)).toEqual(['输入 token', '输出 token']);
    expect(charts.tokens.series[0].data).toEqual([100, 60]);
    expect(charts.tokens.stacked).toBe(true);
  });

  it('按模型聚合：标题随维度变化', () => {
    const charts = buildUsageCharts([{ ...rows[0], key: 'deepseek-chat' }], 'model');
    expect(charts.credits.categories).toEqual(['deepseek-chat']);
    expect(charts.credits.title).toContain('按模型');
  });

  it('空数据返回空分类，交给页面显示 Empty', () => {
    const charts = buildUsageCharts([], 'day');
    expect(charts.credits.categories).toEqual([]);
    expect(charts.credits.series[0].data).toEqual([]);
  });
});
