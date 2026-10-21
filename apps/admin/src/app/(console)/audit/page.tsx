'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminAuditItemDto } from '@ai-office/shared';
import { adminErrorText, isForbidden, listAdminAudit } from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function AdminAuditPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminAuditItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [actorId, setActorId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return true;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return true;
      }
      setError(adminErrorText(err));
      return false;
    },
    [router],
  );

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminAudit({
        page,
        pageSize: PAGE_SIZE,
        action,
        targetType,
        targetId,
        actorId,
      });
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
  }, [page, action, targetType, targetId, actorId, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">审计日志</h1>
            <p className="page-sub">写操作与敏感查看记录；不含消息正文与密钥。</p>
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
            placeholder="动作（如 user.update）"
            aria-label="动作"
            value={action}
            onChange={(e) => { setPage(1); setAction(e.target.value); }}
          />
          <input
            className="admin-input"
            placeholder="对象类型"
            aria-label="对象类型"
            value={targetType}
            onChange={(e) => { setPage(1); setTargetType(e.target.value); }}
          />
          <input
            className="admin-input"
            placeholder="对象 ID"
            aria-label="对象 ID"
            value={targetId}
            onChange={(e) => { setPage(1); setTargetId(e.target.value); }}
          />
          <input
            className="admin-input"
            placeholder="操作人 ID"
            aria-label="操作人 ID"
            value={actorId}
            onChange={(e) => { setPage(1); setActorId(e.target.value); }}
          />
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">暂无审计记录</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>对象</th>
                <th>摘要</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>{formatTime(row.createdAt)}</td>
                  <td>{row.actorEmail}</td>
                  <td>{row.action}</td>
                  <td>{row.targetId ? `${row.targetType}: ${row.targetId}` : row.targetType}</td>
                  <td>
                    <code style={{ whiteSpace: 'pre-wrap' }}>
                      {row.summary ? JSON.stringify(row.summary) : '—'}
                    </code>
                  </td>
                  <td>{row.ip || '—'}</td>
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
            disabled={page * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
