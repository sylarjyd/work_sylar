export interface AdminNavItem {
  href: string;
  label: string;
}

export interface AdminNavGroup {
  key: string;
  label: string;
  items: AdminNavItem[];
}

/** 运营端分组导航：按业务域分组；组名作为二级菜单，可点击折叠。 */
export const ADMIN_NAV: AdminNavGroup[] = [
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
    key: 'models',
    label: '模型与配置',
    items: [
      { href: '/models', label: '模型配置' },
      { href: '/settings', label: '参数配置' },
      { href: '/qa-cache', label: '缓存管理' },
    ],
  },
  {
    key: 'security',
    label: '安全审计',
    items: [{ href: '/audit', label: '审计日志' }],
  },
];

export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((group) => group.items);

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
