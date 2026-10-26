'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Layout, Menu } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  BookOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MessageOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import type { SessionSummary } from '@ai-office/shared';
import {
  clearToken,
  fetchMe,
  getEmail,
  getRole,
  getToken,
  isUnauthorized,
  listSessions,
} from '../lib/api';
import { relativeTime } from '../lib/format';
import { filterSessions } from '../lib/session-filter';
import { IconSpark } from './icons';

type ActiveNav = 'workbench' | 'assistants' | 'kb' | 'connectors' | 'billing';

// 运营端是独立应用（通常部署在内网），这里只放外链；未配置时对管理员也不显示。
// 构建期内联：生产镜像需要在构建时传入 NEXT_PUBLIC_ADMIN_URL。
const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:3001' : '');

interface AppShellProps {
  active: ActiveNav;
  children: ReactNode;
  sessions?: SessionSummary[];
  sessionId?: string;
  onSelectSession?: (id: string) => void;
  onNewSession?: () => void;
  sessionDisabled?: boolean;
}

const NAV: { key: ActiveNav; href: string; label: string; icon: ReactNode }[] = [
  { key: 'workbench', href: '/', label: '工作台', icon: <MessageOutlined /> },
  { key: 'assistants', href: '/assistants', label: '助手', icon: <RobotOutlined /> },
  { key: 'kb', href: '/kb', label: '知识库', icon: <BookOutlined /> },
  { key: 'connectors', href: '/connectors', label: '连接器', icon: <ApiOutlined /> },
  { key: 'billing', href: '/billing', label: '套餐与用量', icon: <WalletOutlined /> },
];

export function AppShell({
  active,
  children,
  sessions,
  sessionId,
  onSelectSession,
  onNewSession,
  sessionDisabled,
}: AppShellProps) {
  const router = useRouter();
  // 角色与邮箱只在挂载后读取：SSR 阶段没有 localStorage，渲染期读取会触发 hydration 不一致。
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  // 其它页面不传 sessions：由外壳自行拉取，保证最近会话在任意菜单下都能看到。
  const [remoteSessions, setRemoteSessions] = useState<SessionSummary[] | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const cachedRole = getRole() ?? '';
    const cachedEmail = getEmail() ?? '';
    setRole(cachedRole);
    setEmail(cachedEmail);
    // 先用本地缓存渲染，再用 /me 刷新：补齐存量 token 缺失的邮箱，并同步角色变更。
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetchMe()
      .then((user) => {
        // 退出或切换账号后 token 会变化，迟到响应不再覆盖新状态。
        if (cancelled || getToken() !== token) return;
        setRole(user.role);
        setEmail(user.email);
      })
      .catch((err) => {
        if (!cancelled && isUnauthorized(err)) router.replace('/login');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    // 工作台自己管理会话列表（含新建后的即时插入），这里只在外层未提供时兜底。
    if (sessions !== undefined) return;
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    listSessions()
      .then((list) => {
        if (cancelled || getToken() !== token) return;
        setRemoteSessions(list);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          router.replace('/login');
          return;
        }
        // 拉取失败也要结束骨架态，避免最近会话区一直缺失。
        setRemoteSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessions, router]);

  // 折叠状态挂载后读取，避免服务端渲染与水合结果不一致；
  // 默认收起，用户手动展开后以手动选择为准。
  useEffect(() => {
    const stored = window.localStorage.getItem('wb.sidebar.collapsed');
    if (stored === '0') setCollapsed(false);
    else setCollapsed(true);
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const historySessions = sessions ?? remoteSessions;
  const visibleSessions = useMemo(
    () => filterSessions(historySessions ?? [], query),
    [historySessions, query],
  );

  function persistCollapsed(next: boolean) {
    setCollapsed(next);
    window.localStorage.setItem('wb.sidebar.collapsed', next ? '1' : '0');
    if (next) {
      setSearchOpen(false);
      setQuery('');
    }
  }

  function toggleCollapsed() {
    persistCollapsed(!collapsed);
  }

  function toggleSearch() {
    // 窄屏自动收起时点击搜索，视为用户手动展开：显式落盘，优先于自动规则。
    if (collapsed) persistCollapsed(false);
    const next = !searchOpen;
    setSearchOpen(next);
    if (!next) setQuery('');
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setSearchOpen(false);
      setQuery('');
      // 输入框卸载后焦点会掉到 body，显式还给触发它的搜索按钮。
      searchButtonRef.current?.focus();
    }
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  // 其它菜单页没有会话状态，点击后回到工作台并按 ?session 打开该会话。
  function selectSession(id: string) {
    if (onSelectSession) {
      onSelectSession(id);
      return;
    }
    router.push(`/?session=${encodeURIComponent(id)}`);
  }

  const menuItems = [
    ...NAV.map(({ key, label, icon }) => ({ key, label, icon })),
    ...(role === 'admin' && ADMIN_URL
      ? [{ key: 'admin', label: '运营平台', icon: <AppstoreOutlined /> }]
      : []),
  ];

  function onMenuClick(key: string) {
    // 运营端是独立应用，用新标签页打开，避免离开工作台丢掉未完成的任务。
    if (key === 'admin') {
      window.open(ADMIN_URL, '_blank', 'noopener,noreferrer');
      return;
    }
    const target = NAV.find((item) => item.key === key);
    if (target) router.push(target.href);
  }

  const avatarLetter = email ? email[0].toUpperCase() : '?';

  return (
    <Layout
      hasSider
      className={`shell wb-shell${collapsed ? ' sidebar-collapsed' : ''}`}
    >
      <Layout.Sider
        id="wb-sidebar"
        className="sidebar wb-sidebar"
        width={272}
        collapsedWidth={64}
        collapsed={collapsed}
        trigger={null}
        theme="light"
        aria-label="侧栏"
        style={{ background: 'var(--wb-sidebar)' }}
      >
        <div className="wb-side-head">
          <div className="wb-brand">
            <div className="wb-brand-mark">
              <IconSpark size={17} />
            </div>
            {!collapsed && <div className="wb-brand-name">AI 办公智能体</div>}
          </div>
          <div className="wb-side-tools">
            <button
              type="button"
              className="wb-icon-btn wb-collapse-btn"
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-controls="wb-sidebar"
              aria-expanded={!collapsed}
              title={collapsed ? '展开侧栏' : '收起侧栏'}
            >
              <MenuFoldOutlined />
            </button>
            {historySessions !== undefined && (
              <button
                ref={searchButtonRef}
                type="button"
                className={`wb-icon-btn wb-search-btn${searchOpen ? ' active' : ''}`}
                onClick={toggleSearch}
                aria-label="搜索会话"
                aria-controls="wb-session-search"
                aria-expanded={searchOpen}
                title="搜索会话"
              >
                <SearchOutlined />
              </button>
            )}
          </div>
        </div>

        {historySessions !== undefined && !collapsed && searchOpen && (
          <div className="wb-search">
            <SearchOutlined />
            <input
              id="wb-session-search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="搜索最近任务"
              aria-label="搜索会话"
            />
          </div>
        )}

        {onNewSession ? (
          <button
            type="button"
            className="wb-new-task"
            onClick={onNewSession}
            disabled={sessionDisabled}
            aria-label="新建任务"
            title="新建任务"
          >
            <PlusOutlined />
            {!collapsed && <span>新建任务</span>}
          </button>
        ) : (
          <Link className="wb-new-task" href="/" aria-label="新建任务" title="新建任务">
            <PlusOutlined />
            {!collapsed && <span>新建任务</span>}
          </Link>
        )}

        <Menu
          className="wb-nav-menu"
          mode="inline"
          inlineCollapsed={collapsed}
          selectedKeys={[active]}
          aria-label="主导航"
          items={menuItems}
          onClick={({ key }) => onMenuClick(key)}
          style={{ background: 'transparent', borderInlineEnd: 'none' }}
        />

        {historySessions !== undefined && !collapsed && (
          <div className="wb-recent">
            <div className="wb-recent-label">最近</div>
            <div className="wb-session-list">
              {visibleSessions.length === 0 ? (
                <div className="wb-side-empty">
                  {query ? '没有匹配的会话' : '暂无会话'}
                </div>
              ) : (
                visibleSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`wb-session${s.id === sessionId ? ' active' : ''}`}
                    aria-current={s.id === sessionId ? 'true' : undefined}
                    onClick={() => selectSession(s.id)}
                    disabled={sessionDisabled}
                    title={s.title}
                  >
                    <span className="wb-session-title">{s.title}</span>
                    <span className="wb-session-time">{relativeTime(s.createdAt)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <div className="wb-user">
          <span className="wb-avatar" aria-hidden="true">
            {avatarLetter}
          </span>
          {!collapsed && (
            <div className="wb-user-main">
              <span className="wb-user-email" title={email || undefined}>
                {email || (role === 'admin' ? '管理员' : '成员')}
              </span>
              {email && <span className="wb-user-role">{role === 'admin' ? '管理员' : '成员'}</span>}
            </div>
          )}
          <button
            type="button"
            className="wb-icon-btn"
            onClick={logout}
            aria-label="退出登录"
            title="退出登录"
          >
            <LogoutOutlined />
          </button>
        </div>
      </Layout.Sider>
      <Layout.Content className="main wb-main">{children}</Layout.Content>
    </Layout>
  );
}
