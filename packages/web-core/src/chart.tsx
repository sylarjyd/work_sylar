'use client';

import { useEffect, useRef } from 'react';
import type { EChartsOption } from 'echarts';
import type { EChartsType } from 'echarts/core';

export { buildChartOption, CHART_PALETTE } from './chart-option';

/** 图表配置类型：两个应用都从这里取，避免各自依赖 echarts 只为拿类型。 */
export type ChartOption = EChartsOption;

export interface EChartProps {
  option: EChartsOption;  /** 图表高度（px）；宽度跟随容器，由 ResizeObserver 自适应。 */
  height?: number;
  className?: string;
}

/**
 * ECharts 容器：按需注册图表类型，且只在浏览器里动态加载。
 * 工作台是 SSR 首屏，直接静态引入 echarts 会把整包塞进服务端与首屏 JS；
 * 动态 import 让图表只在真正出现时加载。
 */
export function EChart({ option, height = 280, className }: EChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  // 首帧 option 可能在 echarts 加载完成前就变化，初始化时统一取最新值。
  const optionRef = useRef(option);
  optionRef.current = option;
  // 事件流每次重渲染都会生成新的 option 对象；按内容比较，避免流式刷新把用户的缩放/悬浮重置。
  const appliedRef = useRef('');

  useEffect(() => {
    let alive = true;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);
      const host = hostRef.current;
      if (!alive || !host) return;
      core.use([
        charts.LineChart,
        charts.BarChart,
        charts.PieChart,
        charts.ScatterChart,
        components.GridComponent,
        components.TooltipComponent,
        components.LegendComponent,
        components.TitleComponent,
        components.DataZoomComponent,
        renderers.CanvasRenderer,
      ]);
      const chart = core.init(host, undefined, { renderer: 'canvas' });
      chartRef.current = chart;
      appliedRef.current = JSON.stringify(optionRef.current);
      chart.setOption(optionRef.current, { notMerge: true });
      observer = new ResizeObserver(() => chart.resize());
      observer.observe(host);
    })();
    return () => {
      alive = false;
      observer?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const next = JSON.stringify(option);
    if (next === appliedRef.current) return;
    appliedRef.current = next;
    chart.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={hostRef}
      className={className ? `echart ${className}` : 'echart'}
      style={{ height }}
      role="img"
      aria-label="数据图表"
    />
  );
}
