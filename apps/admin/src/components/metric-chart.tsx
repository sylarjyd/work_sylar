'use client';

import { CHART_PALETTE, EChart, type ChartOption } from '@ai-office/web-core/chart';
import { formatCompact } from './chart-geometry';

export interface ChartSeries {
  name: string;
  values: number[];
}

const INK = '#565d63';
const SPLIT_LINE = '#eef0ec';

function axisBase(labels: string[], formatValue: (value: number) => string) {
  return {
    xAxis: {
      type: 'category' as const,
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: SPLIT_LINE } },
      axisLabel: { color: INK, hideOverlap: true },
    },
    yAxis: {
      type: 'value' as const,
      splitLine: { lineStyle: { color: SPLIT_LINE, type: 'dashed' as const } },
      axisLabel: { color: INK, formatter: (value: number) => formatValue(value) },
    },
  };
}

function legendOf(series: ChartSeries[]) {
  if (series.length <= 1) return undefined;
  return {
    bottom: 0,
    icon: 'roundRect',
    itemWidth: 10,
    itemHeight: 10,
    textStyle: { color: INK, fontSize: 11 },
  };
}

/**
 * 鎶樼嚎鍥撅細杩愯惀绔師鏉ユ墜缁?SVG锛屽彧鏀寔鍥哄畾鍧愭爣涓庡皯閲忕偣锛? * 鎹㈡垚 ECharts 鍚庡彲缂╂斁銆佸彲 tooltip 瀵归綈锛屼篃鍜屽伐浣滃彴/璁¤垂椤靛叡鐢ㄤ竴濂楄瑙夈€? */
export function LineChart({
  title,
  labels,
  series,
  formatValue = formatCompact,
}: {
  title: string;
  labels: string[];
  series: ChartSeries[];
  formatValue?: (value: number) => string;
}) {
  const legend = legendOf(series);
  const option: ChartOption = {
    color: [...CHART_PALETTE],
    tooltip: { trigger: 'axis' },
    ...(legend ? { legend } : {}),
    grid: { left: 8, right: 14, top: 16, bottom: legend ? 28 : 8, containLabel: true },
    ...axisBase(labels, formatValue),
    series: series.map((item, index) => ({
      name: item.name,
      type: 'line' as const,
      data: item.values,
      smooth: true,
      symbol: labels.length > 40 ? 'none' : 'circle',
      symbolSize: 4,
      lineStyle: { width: 2 },
      itemStyle: { color: CHART_PALETTE[index % CHART_PALETTE.length] },
      ...(series.length === 1 ? { areaStyle: { opacity: 0.12 } } : {}),
    })),
  };
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <EChart option={option} height={240} />
    </figure>
  );
}

/** 鍫嗗彔鏌辩姸鍥撅細鐢ㄤ簬銆屾寜妯″瀷鐨勭Н鍒嗘秷鑰椼€嶏紝鍚勬ā鍨嬫寜鏃堕棿妗惰嚜涓嬭€屼笂鍫嗗彔銆?*/
export function StackedBarChart({
  title,
  labels,
  series,
}: {
  title: string;
  labels: string[];
  series: ChartSeries[];
}) {
  const legend = legendOf(series);
  const option: ChartOption = {
    color: [...CHART_PALETTE],
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    ...(legend ? { legend } : {}),
    grid: { left: 8, right: 14, top: 16, bottom: legend ? 28 : 8, containLabel: true },
    ...axisBase(labels, formatCompact),
    series: series.map((item, index) => ({
      name: item.name,
      type: 'bar' as const,
      stack: 'total',
      data: item.values,
      barMaxWidth: 18,
      itemStyle: { color: CHART_PALETTE[index % CHART_PALETTE.length] },
    })),
  };
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <EChart option={option} height={240} />
    </figure>
  );
}
