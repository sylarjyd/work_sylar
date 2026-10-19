'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminUserItemDto, AdminUserPatch } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminUsers,
  updateAdminUser,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminUsersPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminUserItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminUsers({ page, pageSize: 20, q, status, role });
      if (id !== loadSeq.current) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (id !== loadSeq.current) return;
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, q, status, role, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(user: AdminUserItemDto, body: AdminUserPatch) {
    const before = `角色 ${user.role} / 状态 ${user.status}`;
    const after = `角色 ${body.role ?? user.role} / 状态 ${body.status ?? user.status}`;
    if (!window.confirm(`确认修改 ${user.email}？\n${before} → ${after}`)) return;
    setError('');
    try {
      await updateAdminUser(user.id, body);
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(adminErrorText(err));
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">用户管理</h1>
            <p className="page-sub">跨租户查看用户、状态与角色。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input
            className="admin-input"
            placeholder="搜索邮箱"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
          <select className="admin-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
          <select className="admin-input" value={role} onChange={(e) => { setPage(1); setRole(e.target.value); }}>
            <option value="">全部角色</option>
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的用户</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>租户</th>
                <th>角色</th>
                <th>状态</th>
                <th>注册时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.tenantName}</td>
                  <td>{u.role === 'admin' ? '管理员' : '成员'}</td>
                  <td>{u.status === 'active' ? '启用' : '禁用'}</td>
                  <td>{new Date(u.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => void patch(u, { status: u.status === 'active' ? 'disabled' : 'active' })}
                    >
                      {u.status === 'active' ? '禁用' : '启用'}
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => void patch(u, { role: u.role === 'admin' ? 'member' : 'admin' })}
                    >
                      {u.role === 'admin' ? '设为成员' : '设为管理员'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="admin-pager">
          <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            className="admin-btn"
            disabled={page * 20 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
