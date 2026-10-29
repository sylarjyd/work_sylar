export interface AdminNavItem {
  href: string;
  label: string;
}

/** 一级菜单：带 href 的直接跳转，否则渲染为可折叠分组。 */
export type AdminNavEntry =
  | { key: string; label: string; href: string }
  | { key: string; label: string; items: AdminNavItem[] };

/** 运营端导航：按业务域分组；分组标题可点击折叠，独立页面直接作为一级菜单。 */
export const ADMIN_NAV: AdminNavEntry[] = [
  {
    key: 'monitor',
    label: '运行监测',
    items: [
      { href: '/overview', label: '运行概览' },
      { href: '/alerts', label: '告警中心' },
    ],
  },
  {
    key: 'customers',
    label: '客户与会员',
    items: [
      { href: '/users', label: '用户管理' },
      { href: '/tenants', label: '会员管理' },
      { href: '/plans', label: '套餐目录' },
    ],
  },
  {
    key: 'conversations',
    label: '会话与任务',
    items: [
      { href: '/sessions', label: '会话管理' },
      { href: '/tasks', label: '任务与运行' },
    ],
  },
  {
    key: 'knowledge',
    label: '知识库',
    items: [{ href: '/kb', label: '知识库管理' }],
  },
  {
    key: 'skills',
    label: '技能市场',
    items: [{ href: '/skills', label: '技能管理' }],
  },
  { key: 'assistants', label: '专家助手', href: '/assistants' },
  {
    key: 'models',
    label: '模型与配置',
    items: [
      { href: '/models', label: '模型配置' },
      { href: '/settings', label: '参数配置' },
    ],
  },
  { key: 'cache', label: '缓存管理', href: '/qa-cache' },
  {
    key: 'security',
    label: '安全审计',
    items: [{ href: '/audit', label: '审计日志' }],
  },
];

export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((entry) =>
  'href' in entry ? [{ href: entry.href, label: entry.label }] : entry.items,
);

/** 当前路径命中的菜单 key；用最长前缀匹配，避免 /tasks 误命中其它路由。 */
export function selectedNavKey(pathname: string | null | undefined): string {
  if (!pathname) return '';
  let matched = '';
  for (const item of ADMIN_NAV_ITEMS) {
    const hit = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (hit && item.href.length > matched.length) matched = item.href;
  }
  return matched;
}
