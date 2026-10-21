'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearToken, getRole } from '@ai-office/web-core';
import { adminRedirectPath } from '../lib/admin-guard';

const NAV = [
  { href: '/overview', label: '运行概览' },
  { href: '/alerts', label: '告警中心' },
  { href: '/users', label: '用户管理' },
  { href: '/tenants', label: '会员管理' },
  { href: '/plans', label: '套餐目录' },
  { href: '/sessions', label: '会话管理' },
  { href: '/tasks', label: '任务与运行' },
  { href: '/models', label: '模型配置' },
  { href: '/settings', label: '参数配置' },
  { href: '/audit', label: '审计日志' },
];

// 构建期内联：未配置时生产环境不显示“返回工作台”。运营端与客户端通常是不同 origin。
const WORKSPACE_URL =
  process.env.NEXT_PUBLIC_WORKSPACE_URL ||
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : '');

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // 角色只在挂载后读取：SSR 阶段没有 localStorage。
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const redirect = adminRedirectPath(getRole());
    if (redirect) {
      router.replace(redirect);
      return;
    }
    setReady(true);
  }, [router]);

  function logout() {
    clearToken();
    router.replace('/login');
  }

  if (!ready) return <div className="admin-loading">校验权限…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">管</div>
          <div>
            <div className="brand-name">运营平台</div>
            <div className="brand-sub">AI 办公智能体</div>
          </div>
        </div>

        <nav className="nav" aria-label="管理导航">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${pathname.startsWith(item.href) ? ' active' : ''}`}
              aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
            >
              <span className="nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="side-foot">
          {WORKSPACE_URL ? (
            <a className="nav-item" href={WORKSPACE_URL} target="_blank" rel="noreferrer">
              <span className="nav-label">返回工作台</span>
            </a>
          ) : null}
          <button type="button" className="icon-btn" onClick={logout} title="退出登录" aria-label="退出登录">
            退出
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
