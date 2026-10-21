'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  getAdminRun,
  getAdminRunTimeline,
  getAdminTask,
  isForbidden,
  listAdminTasks,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';
import { formatDuration } from '../../../components/chart-geometry';
import {
  timelineKindLabel,
  timelineStatusLabel,
  timelineStatusTone,
} from '../../../lib/run-timeline';

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
  const [timeline, setTimeline] = useState<AdminRunTimelineDto | null>(null);
  const [traceCopied, setTraceCopied] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

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
    // 切换任务时让在途的任务/运行请求失效，并清空旧详情，避免「新任务详情 + 旧任务运行」
    runSeq.current++;
    setError('');
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setTaskLoading(true);
    try {
      const data = await getAdminTask(id);
      if (seq !== taskSeq.current) return;
      setDetail(data);
    } catch (err) {
      if (seq !== taskSeq.current) return;
      handleErr(err);
    } finally {
      if (seq === taskSeq.current) setTaskLoading(false);
    }
  }

  function closeTask() {
    // 递增序号让在途的任务/运行请求失效
    taskSeq.current++;
    runSeq.current++;
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setTaskLoading(false);
  }

  async function openRun(id: string) {
    const seq = ++runSeq.current;
    setError('');
    setTimeline(null);
    setTraceCopied(false);
    try {
      // 时间线失败不应拖垮运行详情：两者独立结算，谁成功就先展示谁。
      const [runResult, timelineResult] = await Promise.allSettled([
        getAdminRun(id, { stepPage: 1, stepPageSize: 100 }),
        getAdminRunTimeline(id),
      ]);
      if (seq !== runSeq.current) return;
      if (runResult.status === 'rejected') {
        handleErr(runResult.reason);
        return;
      }
      setRun(runResult.value);
      if (timelineResult.status === 'fulfilled') {
        setTimeline(timelineResult.value);
      } else {
        handleErr(timelineResult.reason);
      }
    } catch (err) {
      if (seq !== runSeq.current) return;
      handleErr(err);
    }
  }

  // 复制失败（非 HTTPS、权限拒绝）时退回手动选择，不阻断时间线展示。
  async function copyTrace(traceId: string) {
    try {
      await navigator.clipboard.writeText(traceId);
      setTraceCopied(true);
    } catch {
      setError('复制失败，请手动选择 traceId');
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
            <option value="queued">排队中</option>
            <option value="done">完成</option>
            <option value="failed">失败</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {!detail && taskLoading && <div className="admin-empty">任务详情加载中…</div>}

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">任务 {detail.id}</h2>
            <p className="admin-muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.goal}</p>
            {detail.runs.length === 0 ? (
              <div className="admin-empty">暂无运行</div>
            ) : (
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
            )}
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
            {timeline && (
              <div className="run-timeline">
                <h3 className="billing-heading">时间线</h3>
                <p className="admin-muted">
                  {timeline.nodes.length} 个节点 · 用时 {formatDuration(timeline.durationMs)} ·
                  tokens {timeline.usage ? timeline.usage.inputTokens : '—'}/
                  {timeline.usage ? timeline.usage.outputTokens : '—'} · 积分{' '}
                  {timeline.usage?.credits ?? '—'}
                </p>
                <p className="admin-muted timeline-trace">
                  trace {timeline.traceId ?? '—'}
                  {timeline.traceId && (
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => {
                        if (timeline.traceId) void copyTrace(timeline.traceId);
                      }}
                    >
                      {traceCopied ? '已复制' : '复制 traceId'}
                    </button>
                  )}
                </p>
                <ol className="timeline-list">
                  {timeline.nodes.map((node) => {
                    const tone = timelineStatusTone(node.status);
                    return (
                      <li key={node.id} className="timeline-node">
                        <span className={`timeline-dot ${tone}`} aria-hidden="true" />
                        <div className="timeline-body">
                          <div className="timeline-head">
                            <span className="timeline-label">{node.label}</span>
                            <span className={`timeline-badge ${tone}`}>
                              {timelineStatusLabel(node.status)}
                            </span>
                            <span className="admin-muted">
                              {new Date(node.startedAt).toLocaleTimeString('zh-CN', {
                                hour12: false,
                              })}
                            </span>
                            {node.durationMs !== null && (
                              <span className="admin-muted">
                                {formatDuration(node.durationMs)}
                              </span>
                            )}
                          </div>
                          <div className="admin-muted">{timelineKindLabel(node.kind)}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {timeline.truncated && (
                  <p className="admin-muted">节点过多，已省略部分节点。</p>
                )}
              </div>
            )}
            {run.steps.items.length === 0 ? (
              <div className="admin-empty">暂无 step</div>
            ) : (
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
            )}
            <p className="admin-muted" style={{ marginTop: 8 }}>共 {run.steps.total} 条 step</p>
            <button
              type="button"
              className="admin-btn"
              onClick={() => {
                // 关闭面板时作废在途的运行请求，避免被迟到响应重新打开
                runSeq.current += 1;
                setRun(null);
                setTimeline(null);
                setTraceCopied(false);
              }}
            >
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
