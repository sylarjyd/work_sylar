import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@ai-office/shared';
import { filterSessions } from './session-filter';

const SESSIONS: SessionSummary[] = [
  { id: '1', title: '写一份周报', createdAt: '2026-10-21T04:00:00.000Z' },
  { id: '2', title: '调研竞品 WorkBuddy', createdAt: '2026-10-20T04:00:00.000Z' },
  { id: '3', title: '生成演示稿', createdAt: '2026-10-19T04:00:00.000Z' },
];

describe('filterSessions', () => {
  it('空关键字返回原列表', () => {
    expect(filterSessions(SESSIONS, '')).toBe(SESSIONS);
    expect(filterSessions(SESSIONS, '   ')).toBe(SESSIONS);
  });

  it('按标题做大小写不敏感的子串匹配', () => {
    expect(filterSessions(SESSIONS, 'workbuddy').map((s) => s.id)).toEqual(['2']);
    expect(filterSessions(SESSIONS, '周报').map((s) => s.id)).toEqual(['1']);
  });

  it('去除首尾空格后匹配', () => {
    expect(filterSessions(SESSIONS, '  演示  ').map((s) => s.id)).toEqual(['3']);
  });

  it('无匹配返回空数组', () => {
    expect(filterSessions(SESSIONS, '不存在的标题')).toEqual([]);
  });
});
