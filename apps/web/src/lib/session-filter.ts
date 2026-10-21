import type { SessionSummary } from '@ai-office/shared';

/** 侧栏会话搜索：标题子串、大小写不敏感；空关键字直接返回原数组。 */
export function filterSessions(
  sessions: SessionSummary[],
  query: string,
): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
}
