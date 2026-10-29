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
  type UIEvent,
} from 'react';
import { Dropdown, Input, Layout, Menu, message, Modal } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  BookOutlined,
  BulbOutlined,
  DeleteOutlined,
  EditOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RobotOutlined,
  SearchOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  SESSION_PAGE_SIZE,
  type SessionSummary,
  type UpdateSessionRequest,
} from '@ai-office/shared';
import {
  clearToken,
  deleteSession,
  fetchMe,
  getEmail,
  getRole,
  getToken,
  isUnauthorized,
  listSessions,
  updateSession,
} from '../lib/api';
import { relativeTime } from '../lib/format';
import { filterSessions, sortSessions } from '../lib/session-filter';
import { IconSpark } from './icons';

type ActiveNav = 'workbench' | 'assistants' | 'kb' | 'skills' | 'connectors' | 'billing';

// 运营端是独立应用（通常部署在内网），这里只放外链；未配置时对管理员也不显示。
// 构建期内联：生产镜像需要在构建时传入 NEXT_PUBLIC_ADMIN_URL。
const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:3001' : '');

interface AppShellProps {
  active: ActiveNav;
  children: ReactNode;
  sessions?: SessionSummary[];
  /** 由外层管理会话列表时，告诉外壳是否还有下一页/正在加载。 */
  sessionsHasMore?: boolean;
  sessionsLoadingMore?: boolean;
  onLoadMoreSessions?: () => void;
  sessionId?: string;
  onSelectSession?: (id: string) => void;
  onNewSession?: () => void;
  /** 工作台自行维护会话列表，改名/置顶与删除交给它更新状态；其它页面由外壳兜底。 */
  onUpdateSession?: (id: string, patch: UpdateSessionRequest) => Promise<void>;
  onDeleteSession?: (id: string) => Promise<void>;
}

/** 会话操作失败的提示：后端用状态码表达「运行中」与「已不存在」，这里翻译成用户能懂的话。 */
function actionErrorText(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('409')) return '会话还有任务在运行，请先停止后再删除';
  if (msg.includes('404')) return '会话不存在或已被删除';
  return fallback;
}

const NAV: { key: ActiveNav; href: string; label: string; icon: ReactNode }[] = [
  { key: 'workbench', href: '/', label: '工作台', icon: <MessageOutlined /> },
  { key: 'assistants', href: '/assistants', label: '专家助手', icon: <RobotOutlined /> },
  { key: 'skills', href: '/skills', label: '技能市场', icon: <BulbOutlined /> },
  { key: 'kb', href: '/kb', label: '知识库', icon: <BookOutlined /> },
  { key: 'connectors', href: '/connectors', label: '连接器', icon: <ApiOutlined /> },
  { key: 'billing', href: '/billing', label: '套餐订阅', icon: <WalletOutlined /> },
];

export function AppShell({
  active,
  children,
  sessions,
  sessionsHasMore,
  sessionsLoadingMore,
  onLoadMoreSessions,
  sessionId,
  onSelectSession,
  onNewSession,
  onUpdateSession,
  onDeleteSession,
}: AppShellProps) {
  const router = useRouter();
  // 角色与邮箱只在挂载后读取：SSR 阶段没有 localStorage，渲染期读取会触发 hydration 不一致。
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  // 其它页面不传 sessions：由外壳自行拉取，保证最近会话在任意菜单下都能看到。
  const [remoteSessions, setRemoteSessions] = useState<SessionSummary[] | undefined>(undefined);
  const [remoteCursor, setRemoteCursor] = useState<string | null>(null);
  const [remoteLoadingMore, setRemoteLoadingMore] = useState(false);
  // 滚动事件可能在重渲染前连发，用 ref 同步占位防止同一游标被并发请求两次。
  const remoteLoadingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

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
    listSessions({ limit: SESSION_PAGE_SIZE })
      .then((page) => {
        if (cancelled || getToken() !== token) return;
        setRemoteSessions(page.items);
        setRemoteCursor(page.nextCursor);
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

  async function loadMoreRemote() {
    if (remoteLoadingRef.current || remoteCursor === null) return;
    const token = getToken();
    if (!token) return;
    remoteLoadingRef.current = true;
    setRemoteLoadingMore(true);
    try {
      const page = await listSessions({ limit: SESSION_PAGE_SIZE, cursor: remoteCursor });
      if (getToken() !== token) return;
      setRemoteSessions((prev) => [...(prev ?? []), ...page.items]);
      setRemoteCursor(page.nextCursor);
    } catch (err) {
      // 翻页失败保留游标，用户再次滑到底时可重试；只有掉登录才需要跳转。
      if (isUnauthorized(err)) router.replace('/login');
    } finally {
      remoteLoadingRef.current = false;
      setRemoteLoadingMore(false);
    }
  }

  const hasMoreSessions = sessions !== undefined ? !!sessionsHasMore : remoteCursor !== null;
  const loadingMoreSessions = sessions !== undefined ? !!sessionsLoadingMore : remoteLoadingMore;
  const loadMoreSessions = sessions !== undefined ? onLoadMoreSessions : loadMoreRemote;

  function onSessionListScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    // 距底 64px 内就预取，避免滚动到底才看到空白等待。
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 64) return;
    void loadMoreSessions?.();
  }

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

  /** 工作台传入处理器时由它更新列表；其它页面就地更新外壳自己拉取的会话。 */
  async function applyUpdate(id: string, patch: UpdateSessionRequest): Promise<void> {
    if (onUpdateSession) {
      await onUpdateSession(id, patch);
      return;
    }
    const updated = await updateSession(id, patch);
    setRemoteSessions((prev) =>
      prev ? sortSessions(prev.map((s) => (s.id === id ? updated : s))) : prev,
    );
  }

  async function applyDelete(id: string): Promise<void> {
    if (onDeleteSession) {
      await onDeleteSession(id);
      return;
    }
    await deleteSession(id);
    setRemoteSessions((prev) => prev?.filter((s) => s.id !== id));
    if (id === sessionId) router.push('/');
  }

  async function togglePin(s: SessionSummary) {
    try {
      await applyUpdate(s.id, { pinned: !s.pinned });
    } catch (err) {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return;
      }
      message.error(actionErrorText(err, '置顶失败，请稍后重试'));
    }
  }

  function onSessionAction(key: string, s: SessionSummary) {
    if (key === 'pin') {
      void togglePin(s);
      return;
    }
    if (key === 'rename') {
      setRenameValue(s.title);
      setRenameError('');
      setRenameTarget(s);
      return;
    }
    if (key === 'delete') {
      setDeleteError('');
      setDeleteTarget(s);
    }
  }

  async function submitRename() {
    const target = renameTarget;
    if (!target || renaming) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameError('标题不能为空');
      return;
    }
    setRenaming(true);
    setRenameError('');
    try {
      await applyUpdate(target.id, { title });
      setRenameTarget(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return;
      }
      setRenameError(actionErrorText(err, '重命名失败，请稍后重试'));
    } finally {
      setRenaming(false);
      // 成功时目标已清空；失败时保留弹窗让用户修改后重试。
    }
  }

  async function submitDelete() {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await applyDelete(target.id);
      setDeleteTarget(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return;
      }
      setDeleteError(actionErrorText(err, '删除失败，请稍后重试'));
    } finally {
      setDeleting(false);
    }
  }

  function sessionMenuItems(s: SessionSummary) {
    return [
      {
        key: 'pin',
        icon: s.pinned ? <PushpinFilled /> : <PushpinOutlined />,
        label: s.pinned ? '取消置顶' : '置顶',
      },
      { key: 'rename', icon: <EditOutlined />, label: '重命名' },
      { type: 'divider' as const },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
    ];
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
            <div className="wb-session-list" onScroll={onSessionListScroll}>
              {visibleSessions.length === 0 ? (
                <div className="wb-side-empty">
                  {query ? '没有匹配的会话' : '暂无会话'}
                </div>
              ) : (
                visibleSessions.map((s) => (
                  <div
                    key={s.id}
                    className={`wb-session-row${s.id === sessionId ? ' active' : ''}`}
                  >
                    <button
                      type="button"
                      className="wb-session"
                      aria-current={s.id === sessionId ? 'true' : undefined}
                      onClick={() => selectSession(s.id)}
                      title={s.title}
                    >
                      {s.pinned && (
                        <span className="wb-session-pin" title="已置顶" aria-label="已置顶">
                          <PushpinFilled />
                        </span>
                      )}
                      <span className="wb-session-title">{s.title}</span>
                      <span
                        className={`wb-session-time${s.activeRun ? ' wb-session-running' : ''}`}
                      >
                        {s.activeRun && (
                          <span
                            className={`wb-session-dot is-${s.activeRun.status}`}
                            aria-hidden="true"
                          />
                        )}
                        {s.activeRun
                          ? s.activeRun.status === 'queued'
                            ? '排队中'
                            : '运行中'
                          : relativeTime(s.createdAt)}
                      </span>
                    </button>
                    <Dropdown
                      trigger={['click']}
                      placement="bottomRight"
                      menu={{
                        items: sessionMenuItems(s),
                        onClick: ({ key }) => onSessionAction(key, s),
                      }}
                    >
                      <button
                        type="button"
                        className="wb-session-action"
                        aria-label={`会话操作：${s.title}`}
                        title="会话操作"
                      >
                        <MoreOutlined />
                      </button>
                    </Dropdown>
                  </div>
                ))
              )}
              {loadingMoreSessions && (
                <div className="wb-session-more">加载中…</div>
              )}
              {!hasMoreSessions && (historySessions?.length ?? 0) > SESSION_PAGE_SIZE && (
                <div className="wb-session-more">已加载全部</div>
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
      <Modal
        open={renameTarget !== null}
        title="重命名会话"
        okText="保存"
        cancelText="取消"
        confirmLoading={renaming}
        onOk={submitRename}
        onCancel={() => {
          if (!renaming) setRenameTarget(null);
        }}
        destroyOnHidden
        maskClosable={!renaming}
      >
        <Input
          value={renameValue}
          onChange={(e) => {
            setRenameValue(e.target.value);
            if (renameError) setRenameError('');
          }}
          onPressEnter={submitRename}
          maxLength={40}
          showCount
          autoFocus
          aria-label="会话标题"
          disabled={renaming}
        />
        {renameError && <div className="wb-modal-error">{renameError}</div>}
      </Modal>
      <Modal
        open={deleteTarget !== null}
        title="删除会话"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={deleting}
        onOk={submitDelete}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        destroyOnHidden
        maskClosable={!deleting}
      >
        <div className="wb-modal-text">
          确定删除「{deleteTarget?.title}」吗？删除后不再显示，相关记录会保留。
        </div>
        {deleteError && <div className="wb-modal-error">{deleteError}</div>}
      </Modal>
    </Layout>
  );
}
