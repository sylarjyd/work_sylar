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
import { clearToken, isUnauthorized } from '@ai-office/web-core';

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
  const [notice, setNotice] = useState('');
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminUsers({ page, pageSize: 20, q, status, role });
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setItems(data.items);
      setTotal(data.total);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      if (isUnauthorized(err)) {
        router.replace('/login');
        return false;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return false;
      }
      setError(adminErrorText(err));
      return false;
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, q, status, role, router]);

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // 防重提交：确认框之后、首个 await 之前占位，finally 复位。
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function patch(user: AdminUserItemDto, body: AdminUserPatch) {
    if (inFlight.current) return;
    const before = `角色 ${user.role} / 状态 ${user.status}`;
    const after = `角色 ${body.role ?? user.role} / 状态 ${body.status ?? user.status}`;
    if (!window.confirm(`确认修改 ${user.email}？\n${before} → ${after}`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await updateAdminUser(user.id, body);
      // 写操作已成功，先给出明确提示，避免补刷新失败被误判为写失败而重复提交
      setNotice('操作已成功，正在刷新数据…');
      const ok = await loadRef.current();
      setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
    } catch (err) {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return;
      }
      setError(adminErrorText(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
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

        {notice && (
          <div
            className="banner"
            role="status"
            style={{ marginBottom: 16, background: 'var(--surface-2)', border: '1px solid var(--line)' }}
          >
            {notice}
          </div>
        )}

        <div className="admin-toolbar">
          <input
            className="admin-input"
            placeholder="搜索邮箱"
            value={q}
            disabled={busy}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
          <select className="admin-input" value={status} disabled={busy} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
          <select className="admin-input" value={role} disabled={busy} onChange={(e) => { setPage(1); setRole(e.target.value); }}>
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
                      disabled={busy}
                      onClick={() => void patch(u, { status: u.status === 'active' ? 'disabled' : 'active' })}
                    >
                      {u.status === 'active' ? '禁用' : '启用'}
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy}
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
          <button type="button" className="admin-btn" disabled={busy || page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            className="admin-btn"
            disabled={busy || page * 20 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
