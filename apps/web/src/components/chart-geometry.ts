export interface ChartPoint {
  x: number;
  y: number;
}

export interface LineGeometry {
  path: string;
  points: ChartPoint[];
}

export interface StackSegment {
  start: number;
  size: number;
  value: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 坐标轴上限：向上取整到 1/2/5 的整十倍，避免刻度出现长小数。 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** 把 [0, max] 均分成 count 段，返回 count + 1 个刻度值。 */
export function axisTicks(max: number, count = 4): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, index) => round1(step * index));
}

/**
 * 折线几何：x 轴按点序均分，y 轴按 max 线性映射并夹取到 [0, max]。
 * max 非法时回退到 1，保证不会出现除零或 NaN 坐标。
 */
export function lineGeometry(
  values: number[],
  width: number,
  height: number,
  padding: number,
  max: number,
): LineGeometry {
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  const cap = max > 0 ? max : 1;
  const denominator = Math.max(1, values.length - 1);
  const points = values.map((value, index) => ({
    x: round1(padding + (innerWidth * index) / denominator),
    y: round1(padding + innerHeight - (innerHeight * Math.min(cap, Math.max(0, value))) / cap),
  }));
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');
  return { path, points };
}

/**
 * 计算某个时间桶内各系列的堆叠区间：start 是从柱子底部累计的偏移，
 * size 是该系列自身高度，value 保留原始数值供 tooltip 使用。
 */
export function stackSegments(
  valuesBySeries: number[][],
  bucket: number,
  innerHeight: number,
  max: number,
): StackSegment[] {
  const cap = max > 0 ? max : 1;
  let cursor = 0;
  return valuesBySeries.map((values) => {
    const value = Math.max(0, values[bucket] ?? 0);
    const size = (value / cap) * innerHeight;
    const segment = { start: cursor, size, value };
    cursor += size;
    return segment;
  });
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${Math.round(abs)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
