'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearToken, getRole } from '../lib/api';
import { adminRedirectPath } from '../lib/admin-guard';

const NAV = [
  { href: '/admin/overview', label: '运行概览' },
  { href: '/admin/users', label: '用户管理' },
  { href: '/admin/tenants', label: '会员管理' },
  { href: '/admin/plans', label: '套餐目录' },
  { href: '/admin/sessions', label: '会话管理' },
  { href: '/admin/tasks', label: '任务与运行' },
  { href: '/admin/models', label: '模型配置' },
  { href: '/admin/settings', label: '参数配置' },
  { href: '/admin/audit', label: '审计日志' },
];

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
    router.push('/login');
  }

  if (!ready) return <div className="admin-loading">校验权限…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">管</div>
          <div>
            <div className="brand-name">管理后台</div>
            <div className="brand-sub">平台运营</div>
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
          <Link className="nav-item" href="/">
            <span className="nav-label">返回工作台</span>
          </Link>
          <button type="button" className="icon-btn" onClick={logout} title="退出登录" aria-label="退出登录">
            退出
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
