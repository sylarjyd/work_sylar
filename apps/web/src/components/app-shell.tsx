'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { SessionSummary } from '@ai-office/shared';
import { clearToken, getRole } from '../lib/api';
import { IconBook, IconChat, IconLogout, IconPlug, IconPlus, IconSpark } from './icons';

type ActiveNav = 'workbench' | 'kb' | 'connectors';

interface AppShellProps {
  active: ActiveNav;
  children: ReactNode;
  sessions?: SessionSummary[];
  sessionId?: string;
  onSelectSession?: (id: string) => void;
  onNewSession?: () => void;
  sessionDisabled?: boolean;
}

const NAV: { key: ActiveNav; href: string; label: string; icon: typeof IconChat }[] = [
  { key: 'workbench', href: '/', label: '工作台', icon: IconChat },
  { key: 'kb', href: '/kb', label: '知识库', icon: IconBook },
  { key: 'connectors', href: '/connectors', label: '连接器', icon: IconPlug },
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
  // 角色只在挂载后读取：SSR 阶段没有 localStorage，渲染期读取会触发 hydration 不一致。
  const [role, setRole] = useState('');
  useEffect(() => setRole(getRole() ?? ''), []);

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <IconSpark size={17} />
          </div>
          <div>
            <div className="brand-name">AI 办公智能体</div>
            <div className="brand-sub">智能工作台</div>
          </div>
        </div>

        {onNewSession ? (
          <button
            type="button"
            className="nav-item new-task"
            onClick={onNewSession}
            disabled={sessionDisabled}
            aria-label="新建任务"
            title="新建任务"
          >
            <IconPlus size={16} />
            <span className="nav-label">新建任务</span>
          </button>
        ) : (
          <Link className="nav-item new-task" href="/" aria-label="新建任务" title="新建任务">
            <IconPlus size={16} />
            <span className="nav-label">新建任务</span>
          </Link>
        )}

        <nav className="nav" aria-label="主导航">
          {NAV.map(({ key, href, label, icon: Icon }) => (
            <Link
              key={key}
              href={href}
              className={`nav-item${active === key ? ' active' : ''}`}
              aria-current={active === key ? 'page' : undefined}
              aria-label={label}
              title={label}
            >
              <Icon size={16} />
              <span className="nav-label">{label}</span>
            </Link>
          ))}
        </nav>

        {sessions !== undefined && (
          <div className="side-section">
            <div className="side-label">最近任务</div>
            <div className="session-list">
              {sessions.length === 0 ? (
                <div className="side-empty">暂无会话</div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`session-item${s.id === sessionId ? ' active' : ''}`}
                    onClick={() => onSelectSession?.(s.id)}
                    disabled={sessionDisabled}
                    title={s.title}
                  >
                    {s.title}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <div className="side-foot">
          {role && <span className="role-chip">{role === 'admin' ? '管理员' : '成员'}</span>}
          <button type="button" className="icon-btn" onClick={logout} title="退出登录" aria-label="退出登录">
            <IconLogout size={16} />
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
