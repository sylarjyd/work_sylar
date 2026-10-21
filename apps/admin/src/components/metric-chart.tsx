'use client';

import {
  axisTicks,
  formatCompact,
  lineGeometry,
  niceMax,
  stackSegments,
} from './chart-geometry';

export interface ChartSeries {
  name: string;
  values: number[];
}

const WIDTH = 640;
const HEIGHT = 240;
const PADDING = 40;
const INNER_WIDTH = WIDTH - PADDING * 2;
const INNER_HEIGHT = HEIGHT - PADDING * 2;

/** 8 色分类色板；超出的系列循环取色，图例仍按名称区分。 */
const COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4d7c0f',
];

function Legend({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <ul className="chart-legend">
      {names.map((name, index) => (
        <li key={`${name}-${index}`}>
          <span
            className="chart-swatch"
            style={{ background: COLORS[index % COLORS.length] }}
            aria-hidden="true"
          />
          {name}
        </li>
      ))}
    </ul>
  );
}

function YAxis({
  max,
  formatValue,
}: {
  max: number;
  formatValue: (value: number) => string;
}) {
  return (
    <>
      {axisTicks(max).map((tick) => {
        const y = PADDING + INNER_HEIGHT - (INNER_HEIGHT * tick) / max;
        return (
          <g key={tick}>
            <line x1={PADDING} y1={y} x2={WIDTH - PADDING} y2={y} className="chart-grid" />
            <text x={PADDING - 8} y={y + 4} textAnchor="end" className="chart-axis">
              {formatValue(tick)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** 只标首、中、尾三个时间点，窄屏上也不会互相压字。 */
function XAxisLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  const indices =
    labels.length <= 2
      ? labels.map((_, index) => index)
      : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  return (
    <>
      {indices.map((index) => (
        <text
          key={index}
          x={PADDING + (INNER_WIDTH * index) / Math.max(1, labels.length - 1)}
          y={HEIGHT - 12}
          textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}
          className="chart-axis"
        >
          {labels[index]}
        </text>
      ))}
    </>
  );
}

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
  const max = niceMax(Math.max(0, ...series.flatMap((item) => item.values)));
  const names = series.map((item) => item.name);
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}趋势图`}
      >
        <title>{title}</title>
        <desc>
          折线图，共 {labels.length} 个时间点；序列：{names.join('、') || '无'}。
        </desc>
        <YAxis max={max} formatValue={formatValue} />
        {series.map((item, index) => (
          <path
            key={item.name}
            d={lineGeometry(item.values, WIDTH, HEIGHT, PADDING, max).path}
            fill="none"
            stroke={COLORS[index % COLORS.length]}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
        <XAxisLabels labels={labels} />
      </svg>
      <Legend names={names} />
    </figure>
  );
}

export function StackedBarChart({
  title,
  labels,
  series,
}: {
  title: string;
  labels: string[];
  series: ChartSeries[];
}) {
  const totals = labels.map((_, index) =>
    series.reduce((sum, item) => sum + Math.max(0, item.values[index] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const slot = INNER_WIDTH / Math.max(1, labels.length);
  const barWidth = Math.max(2, slot * 0.6);
  const names = series.map((item) => item.name);
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}堆叠柱状图`}
      >
        <title>{title}</title>
        <desc>
          堆叠柱状图，共 {labels.length} 个时间点；自下而上依次为：
          {names.join('、') || '无'}。
        </desc>
        <YAxis max={max} formatValue={formatCompact} />
        {labels.map((label, index) => {
          const x = PADDING + slot * index + (slot - barWidth) / 2;
          const segments = stackSegments(
            series.map((item) => item.values),
            index,
            INNER_HEIGHT,
            max,
          );
          return (
            <g key={`${label}-${index}`}>
              {segments.map((segment, segmentIndex) =>
                segment.size > 0 ? (
                  <rect
                    key={series[segmentIndex]?.name ?? segmentIndex}
                    x={x}
                    y={PADDING + INNER_HEIGHT - segment.start - segment.size}
                    width={barWidth}
                    height={segment.size}
                    fill={COLORS[segmentIndex % COLORS.length]}
                  >
                    <title>
                      {series[segmentIndex]?.name ?? ''} · {label}：{formatCompact(segment.value)}
                    </title>
                  </rect>
                ) : null,
              )}
            </g>
          );
        })}
        <XAxisLabels labels={labels} />
      </svg>
      <Legend names={names} />
    </figure>
  );
}
