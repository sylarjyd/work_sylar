import type { ChartSpec } from '@ai-office/shared';
import type { EChartsOption } from 'echarts';

/** 与品牌色一致的分类色板；系列按顺序取色，超出后循环。 */
export const CHART_PALETTE = [
  '#00b07b',
  '#2563eb',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4d7c0f',
] as const;

const INK = '#565d63';
const INK_STRONG = '#14171a';
const SPLIT_LINE = '#eef0ec';

/** 分类过多时旋转标签，避免文字互相压盖。 */
const ROTATE_LABEL_THRESHOLD = 8;
/** 超过该数量启用缩放条：复杂图表要能拖动查看局部，而不是挤成一条线。 */
const ZOOM_THRESHOLD = 30;

/**
 * ChartSpec → ECharts option。纯函数的好处是图表配置可单测，
 * 也保证工作台、计费页与运营端三处图表风格一致。
 */
export function buildChartOption(spec: ChartSpec): EChartsOption {
  const title = spec.title
    ? {
        text: spec.title,
        left: 'center' as const,
        top: 6,
        textStyle: { fontSize: 14, fontWeight: 600, color: INK_STRONG },
      }
    : undefined;

  if (spec.kind === 'pie') return buildPieOption(spec, title) as unknown as EChartsOption;

  const color = spec.series.map((_, index) => CHART_PALETTE[index % CHART_PALETTE.length]);
  const zoom = spec.categories.length > ZOOM_THRESHOLD;

  const series = spec.series.map((item, index) => {
    const type = spec.kind === 'area' ? 'line' : spec.kind;
    return {
      name: item.name,
      type,
      data: item.data,
      smooth: spec.kind === 'line' || spec.kind === 'area',
      symbol: spec.categories.length > 60 ? 'none' : 'circle',
      symbolSize: 5,
      ...(spec.kind === 'area' ? { areaStyle: { opacity: 0.18 } } : {}),
      ...(spec.stacked ? { stack: 'total' } : {}),
      itemStyle: { color: color[index] },
      lineStyle: { width: 2 },
      emphasis: { focus: 'series' as const },
    };
  });

  const categoryAxis = {
    type: 'category' as const,
    data: spec.categories,
    boundaryGap: spec.kind === 'bar',
    axisTick: { show: false },
    axisLine: { lineStyle: { color: SPLIT_LINE } },
    axisLabel: {
      color: INK,
      rotate: spec.categories.length > ROTATE_LABEL_THRESHOLD ? 32 : 0,
      hideOverlap: true,
    },
  };
  const valueAxis = {
    type: 'value' as const,
    name: spec.yName,
    nameTextStyle: { color: INK, padding: [0, 0, 4, 0] },
    splitLine: { lineStyle: { color: SPLIT_LINE, type: 'dashed' as const } },
    axisLabel: { color: INK },
  };
  const horizontal = spec.kind === 'bar' && spec.horizontal === true;

  const option: Record<string, unknown> = {
    ...(title ? { title } : {}),
    color: [...CHART_PALETTE],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: spec.kind === 'bar' ? 'shadow' : 'line' },
    },
    ...(spec.series.length > 1
      ? {
          legend: {
            top: title ? 28 : 4,
            icon: 'roundRect',
            itemWidth: 10,
            itemHeight: 10,
            textStyle: { color: INK, fontSize: 11 },
          },
        }
      : {}),
    grid: {
      left: 12,
      right: 18,
      top: title ? 64 : 32,
      bottom: zoom ? 46 : 20,
      containLabel: true,
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    ...(zoom
      ? {
          dataZoom: [
            { type: 'inside', start: 0, end: 40 },
            { type: 'slider', height: 14, bottom: 6, showDetail: false },
          ],
        }
      : {}),
    series,
  };
  return option as unknown as EChartsOption;
}

function buildPieOption(
  spec: ChartSpec,
  title: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values = spec.series[0]?.data ?? [];
  const data = spec.categories.map((name, index) => ({
    name,
    value: values[index] ?? 0,
    itemStyle: { color: CHART_PALETTE[index % CHART_PALETTE.length] },
  }));
  return {
    ...(title ? { title } : {}),
    color: [...CHART_PALETTE],
    tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
    legend: {
      bottom: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: INK, fontSize: 11 },
    },
    series: [
      {
        type: 'pie',
        radius: ['38%', '62%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
        label: { formatter: '{b}\n{d}%', color: INK, fontSize: 11 },
        data,
      },
    ],
  };
}
