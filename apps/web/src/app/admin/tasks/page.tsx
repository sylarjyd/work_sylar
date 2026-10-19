'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminRunDetailDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  getAdminRun,
  getAdminTask,
  isForbidden,
  listAdminTasks,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminTasksPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminTaskItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tenantId, setTenantId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<AdminTaskDetailDto | null>(null);
  const [run, setRun] = useState<AdminRunDetailDto | null>(null);
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
      const data = await listAdminTasks({ page, pageSize: 20, tenantId, sessionId, userId, status });
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
  }, [page, tenantId, sessionId, userId, status, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const taskSeq = useRef(0);
  const runSeq = useRef(0);

  async function openTask(id: string) {
    const seq = ++taskSeq.current;
    // 切换任务时让在途的运行详情请求失效
    runSeq.current++;
    setError('');
    setRun(null);
    try {
      const data = await getAdminTask(id);
      if (seq !== taskSeq.current) return;
      setDetail(data);
    } catch (err) {
      if (seq !== taskSeq.current) return;
      handleErr(err);
    }
  }

  function closeTask() {
    // 递增序号让在途的任务/运行请求失效
    taskSeq.current++;
    runSeq.current++;
    setDetail(null);
    setRun(null);
  }

  async function openRun(id: string) {
    const seq = ++runSeq.current;
    setError('');
    try {
      const data = await getAdminRun(id, { stepPage: 1, stepPageSize: 100 });
      if (seq !== runSeq.current) return;
      setRun(data);
    } catch (err) {
      if (seq !== runSeq.current) return;
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">任务与运行</h1>
            <p className="page-sub">只读排障：任务、运行、step 与用量。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input className="admin-input" placeholder="租户 ID" value={tenantId} onChange={(e) => { setPage(1); setTenantId(e.target.value); }} />
          <input className="admin-input" placeholder="会话 ID" value={sessionId} onChange={(e) => { setPage(1); setSessionId(e.target.value); }} />
          <input className="admin-input" placeholder="用户 ID" value={userId} onChange={(e) => { setPage(1); setUserId(e.target.value); }} />
          <select className="admin-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="running">运行中</option>
            <option value="done">完成</option>
            <option value="failed">失败</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">任务 {detail.id}</h2>
            <p className="admin-muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.goal}</p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>运行</th>
                  <th>状态</th>
                  <th>开始</th>
                  <th>结束</th>
                  <th>积分</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.status}</td>
                    <td>{new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>{r.endedAt ? new Date(r.endedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                    <td className="numeric">{r.credits ?? '—'}</td>
                    <td>
                      <button type="button" className="admin-btn" onClick={() => void openRun(r.id)}>
                        查看 step
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="admin-btn" style={{ marginTop: 12 }} onClick={closeTask}>
              关闭
            </button>
          </section>
        )}

        {run && (
          <section className="admin-panel">
            <h2 className="billing-heading">运行 {run.id}</h2>
            <p className="admin-muted">
              状态 {run.status} · tokens {run.usage?.inputTokens ?? 0}/{run.usage?.outputTokens ?? 0} · 积分 {run.usage?.credits ?? '—'}
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>seq</th>
                  <th>类型</th>
                  <th>payload</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {run.steps.items.map((s) => (
                  <tr key={s.id}>
                    <td className="numeric">{s.seq}</td>
                    <td>{s.type}</td>
                    <td><code style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(s.payload)}</code></td>
                    <td>{new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="admin-muted" style={{ marginTop: 8 }}>共 {run.steps.total} 条 step</p>
            <button type="button" className="admin-btn" onClick={() => setRun(null)}>
              关闭运行详情
            </button>
          </section>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的任务</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>会话</th>
                <th>目标</th>
                <th>状态</th>
                <th>最近运行</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.sessionId}</td>
                  <td>{t.goal}</td>
                  <td>{t.status}</td>
                  <td>{t.latestRunStatus ?? '—'}</td>
                  <td>{new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button type="button" className="admin-btn" onClick={() => void openTask(t.id)}>
                      详情
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
