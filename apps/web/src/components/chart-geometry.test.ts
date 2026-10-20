import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  formatCompact,
  formatDuration,
  lineGeometry,
  niceMax,
  stackSegments,
} from './chart-geometry';

describe('chart-geometry', () => {
  it('niceMax 向上取整到 1/2/5 的整十倍', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(23)).toBe(50);
    expect(niceMax(1200)).toBe(2000);
  });

  it('axisTicks 把 0 到上限均分', () => {
    expect(axisTicks(10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('lineGeometry 均分 x 轴并把数值映射到 y 轴', () => {
    const result = lineGeometry([0, 50, 100], 100, 100, 10, 100);
    expect(result.points).toEqual([
      { x: 10, y: 90 },
      { x: 50, y: 50 },
      { x: 90, y: 10 },
    ]);
    expect(result.path).toBe('M10,90 L50,50 L90,10');
  });

  it('lineGeometry 对越界值做夹取，单点不产生负坐标', () => {
    const result = lineGeometry([-10, 200], 100, 100, 10, 100);
    expect(result.points).toEqual([
      { x: 10, y: 90 },
      { x: 90, y: 10 },
    ]);
    expect(lineGeometry([5], 100, 100, 10, 10).points).toEqual([{ x: 10, y: 50 }]);
  });

  it('stackSegments 自下而上累计，跳过缺失桶', () => {
    const segments = stackSegments([[1, 2], [3, 0]], 0, 100, 4);
    expect(segments).toEqual([
      { start: 0, size: 25, value: 1 },
      { start: 25, size: 75, value: 3 },
    ]);
    expect(stackSegments([[1], [2]], 3, 100, 10)).toEqual([
      { start: 0, size: 0, value: 0 },
      { start: 0, size: 0, value: 0 },
    ]);
  });

  it('formatCompact 用 k/M 缩写', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(1000)).toBe('1k');
    expect(formatCompact(12500)).toBe('12.5k');
    expect(formatCompact(1_000_000)).toBe('1M');
    expect(formatCompact(-1500)).toBe('-1.5k');
    expect(formatCompact(Number.NaN)).toBe('—');
  });

  it('formatDuration 按毫秒/秒/分展示', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(12_400)).toBe('12.4s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });
});
