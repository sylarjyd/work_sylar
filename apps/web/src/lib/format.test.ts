import { describe, expect, it } from 'vitest';
import { relativeTime } from './format';

// 用本地时间构造，避免测试机时区不同导致「日期」断言的跨天抖动。
const NOW = new Date(2026, 9, 21, 12, 0, 0);

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('relativeTime', () => {
  it('60 秒内显示「刚刚」', () => {
    expect(relativeTime(ago(30_000), NOW)).toBe('刚刚');
  });

  it('1 小时内按分钟显示', () => {
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5 分钟前');
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe('59 分钟前');
  });

  it('24 小时内按小时显示', () => {
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3 小时前');
  });

  it('7 天内按天显示', () => {
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2 天前');
    expect(relativeTime(ago(6 * 86_400_000), NOW)).toBe('6 天前');
  });

  it('超过 7 天回退为本地日期', () => {
    expect(relativeTime(new Date(2026, 9, 1, 12).toISOString(), NOW)).toBe('2026-10-01');
  });

  it('未来时间按「刚刚」处理，非法时间返回空串', () => {
    expect(relativeTime(new Date(NOW.getTime() + 10_000).toISOString(), NOW)).toBe('刚刚');
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});
