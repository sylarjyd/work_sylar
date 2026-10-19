'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminMessageDto, AdminSessionDetailDto, AdminSessionItemDto } from '@ai-office/shared';
import {
  adminErrorText,
  archiveAdminSession,
  getAdminSession,
  isForbidden,
  listAdminMessages,
  listAdminSessions,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminSessionsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminSessionItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [userId, setUserId] = useState('');
  const [detail, setDetail] = useState<AdminSessionDetailDto | null>(null);
  const [messages, setMessages] = useState<AdminMessageDto[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return true;
      }
      if (isForbidden(err)) {
        router.push('/');
        return true;
      }
      setError(adminErrorText(err));
      return false;
    },
    [router],
  );

  const loadSeq = useRef(0);
  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminSessions({ page, pageSize: 20, q, status, tenantId, userId });
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setItems(data.items);
      setTotal(data.total);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, q, status, tenantId, userId, handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const detailSeq = useRef(0);
  const messageSeq = useRef(0);

  const loadMessages = useCallback(
    async (id: string, targetPage: number): Promise<boolean> => {
      const seq = ++messageSeq.current;
      try {
        const data = await listAdminMessages(id, { page: targetPage, pageSize: 50 });
        // 过期响应不写状态（切换会话或翻页已产生新请求）
        if (seq !== messageSeq.current) return true;
        setMessages(data.items);
        setMessageTotal(data.total);
        setMessagePage(targetPage);
        return true;
      } catch (err) {
        if (seq !== messageSeq.current) return true;
        return !handleErr(err);
      }
    },
    [handleErr],
  );

  async function openDetail(id: string) {
    const seq = ++detailSeq.current;
    setError('');
    try {
      const data = await getAdminSession(id);
      if (seq !== detailSeq.current) return;
      setDetail(data);
      await loadMessages(id, 1);
    } catch (err) {
      if (seq !== detailSeq.current) return;
      handleErr(err);
    }
  }

  function closeDetail() {
    // 递增序号让在途的详情/消息请求失效
    detailSeq.current++;
    messageSeq.current++;
    setDetail(null);
    setMessages([]);
    setMessageTotal(0);
    setMessagePage(1);
  }

  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function archive(item: AdminSessionItemDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认归档会话「${item.title}」？归档后普通用户不可见且不可恢复。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await archiveAdminSession(item.id);
      // 功能性更新：只更新当前详情，避免旧闭包覆盖用户随后打开的其它会话。
      setDetail((d) => (d && d.id === item.id ? { ...d, status: 'archived' } : d));
      await loadRef.current();
    } catch (err) {
      handleErr(err);
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
            <h1 className="page-title">会话管理</h1>
            <p className="page-sub">跨租户查看会话与消息；归档为不可恢复操作。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input className="admin-input" placeholder="标题" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} />
          <input className="admin-input" placeholder="租户 ID" value={tenantId} onChange={(e) => { setPage(1); setTenantId(e.target.value); }} />
          <input className="admin-input" placeholder="用户 ID" value={userId} onChange={(e) => { setPage(1); setUserId(e.target.value); }} />
          <select className="admin-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="active">活跃</option>
            <option value="archived">已归档</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">{detail.title}</h2>
            <p className="admin-muted">
              {detail.userEmail} · 状态 {detail.status} · 消息 {detail.messageCount} · 任务 {detail.taskCount} · 产物 {detail.artifactCount}
            </p>
            {messages.length === 0 ? (
              <div className="admin-empty">暂无消息</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>seq</th>
                    <th>角色</th>
                    <th>内容</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id}>
                      <td className="numeric">{m.seq}</td>
                      <td>{m.role}</td>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{m.content}</td>
                      <td>{new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="admin-pager">
              <button
                type="button"
                className="admin-btn"
                disabled={messagePage <= 1}
                onClick={() => void loadMessages(detail.id, messagePage - 1)}
              >
                上一页
              </button>
              <span>第 {messagePage} 页 / 共 {messageTotal} 条</span>
              <button
                type="button"
                className="admin-btn"
                disabled={messagePage * 50 >= messageTotal}
                onClick={() => void loadMessages(detail.id, messagePage + 1)}
              >
                下一页
              </button>
              <button type="button" className="admin-btn" disabled={busy} onClick={closeDetail}>
                关闭
              </button>
            </div>
          </section>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的会话</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>用户</th>
                <th>租户</th>
                <th>状态</th>
                <th>消息</th>
                <th>任务</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>{s.userEmail}</td>
                  <td>{s.tenantId}</td>
                  <td>{s.status === 'archived' ? '已归档' : '活跃'}</td>
                  <td className="numeric">{s.messageCount}</td>
                  <td className="numeric">{s.taskCount}</td>
                  <td>{new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button type="button" className="admin-btn" disabled={busy} onClick={() => void openDetail(s.id)}>
                      查看
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy || s.status === 'archived'}
                      onClick={() => void archive(s)}
                    >
                      归档
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
          <button type="button" className="admin-btn" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
