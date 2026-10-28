import {
  CHART_KINDS,
  CHART_LIMITS,
  normalizeChartSpec,
  type ChartSpec,
} from '@ai-office/shared';
import type { Tool } from './types';

/**
 * 图表工具：模型只提交「数据 + 类型」，由前端用 ECharts 渲染。
 * 不接收任意 ECharts option —— 配置由前端生成，避免模型注入回调或画出与产品风格不一致的图。
 */
export function createChartTool(): Tool {
  return {
    name: 'chart.render',
    description: [
      '把结构化数据渲染成可视化图表并展示给用户。',
      '适用场景：趋势（line/area）、对比（bar）、占比（pie）、相关性（scatter）。',
      '数据必须来自用户提供的内容或工具检索到的真实结果，禁止编造数值。',
      'categories 与每个 series.data 必须等长；饼图用 categories 作为扇区名、只传一个 series。',
    ].join(' '),
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...CHART_KINDS],
          description: '图表类型：line 折线 / bar 柱状 / area 面积 / pie 饼图 / scatter 散点',
        },
        title: { type: 'string', description: '图表标题（可选）' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: `X 轴分类或饼图扇区名，最多 ${CHART_LIMITS.maxCategories} 项`,
        },
        series: {
          type: 'array',
          description: `数据系列，最多 ${CHART_LIMITS.maxSeries} 个；饼图只取第一个`,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '系列名（图例展示）' },
              data: {
                type: 'array',
                items: { type: 'number' },
                description: '与 categories 等长的数值；缺失项用 null 表示断点',
              },
            },
            required: ['name', 'data'],
          },
        },
        yName: { type: 'string', description: 'Y 轴单位或含义（可选）' },
        stacked: { type: 'boolean', description: '折线/柱状是否堆叠' },
        horizontal: { type: 'boolean', description: '柱状图是否横向（适合长分类名）' },
      },
      required: ['kind', 'categories', 'series'],
    },
    async execute(args): Promise<{ ok: true; chart: ChartSpec }> {
      const chart = normalizeChartSpec(args);
      if (!chart) {
        throw new Error(
          'invalid_chart_spec：需要合法的 kind、非空 categories，以及至少一个与 categories 等长的 series.data',
        );
      }
      return { ok: true, chart };
    },
  };
}
