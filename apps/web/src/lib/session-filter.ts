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

/** 侧栏排序与后端一致：置顶优先，其次创建时间倒序，id 兜底保证顺序稳定。 */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byTime = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
