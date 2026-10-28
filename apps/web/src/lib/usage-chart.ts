import type { ChartSpec, UsageAggregateDto } from '@ai-office/shared';

export interface UsageCharts {
  credits: ChartSpec;
  tokens: ChartSpec;
}

/**
 * 用量表格 → 两张图表：积分消耗看成本，token 看模型负载。
 * 分类键按「日」或「模型」由页面切换，这里只负责把行数据转成图表规格。
 */
export function buildUsageCharts(
  rows: UsageAggregateDto[],
  groupBy: 'day' | 'model',
): UsageCharts {
  const categories = rows.map((row) => row.key);
  const suffix = groupBy === 'day' ? '每日' : '按模型';
  return {
    credits: {
      kind: 'bar',
      title: `${suffix}积分消耗`,
      categories,
      series: [{ name: '消耗积分', data: rows.map((row) => row.credits) }],
    },
    tokens: {
      kind: 'bar',
      title: `${suffix} token 用量`,
      categories,
      series: [
        { name: '输入 token', data: rows.map((row) => row.inputTokens) },
        { name: '输出 token', data: rows.map((row) => row.outputTokens) },
      ],
      stacked: true,
    },
  };
}
