'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminPlanDto,
  AdminTenantDetailDto,
  AdminTenantItemDto,
} from '@ai-office/shared';
import {
  adminAdjustCredits,
  adminErrorText,
  adminSubscribeTenant,
  getAdminTenant,
  isForbidden,
  listAdminPlans,
  listAdminTenants,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

export default function AdminTenantsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminTenantItemDto[]>([]);
  const [plans, setPlans] = useState<AdminPlanDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [planId, setPlanId] = useState('');
  const [detail, setDetail] = useState<AdminTenantDetailDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
  const detailSeq = useRef(0);
  const inFlight = useRef(false);

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

  const load = useCallback(
    async (opts?: { preserveError?: boolean }): Promise<boolean> => {
      const id = ++loadSeq.current;
      setLoading(true);
      // 补刷新时保留详情请求写入的具体错误，避免被列表刷新清掉
      if (!opts?.preserveError) setError('');
      try {
        const [data, planRows] = await Promise.all([
          listAdminTenants({ page, pageSize: 20, q, planId }),
          listAdminPlans(),
        ]);
        // 过期请求：已有更新的请求在途，视为无需提示失败
        if (id !== loadSeq.current) return true;
        setItems(data.items);
        setTotal(data.total);
        setPlans(planRows.filter((p) => p.active));
        return true;
      } catch (err) {
        if (id !== loadSeq.current) return true;
        return !handleErr(err);
      } finally {
        if (id === loadSeq.current) setLoading(false);
      }
    },
    [page, q, planId, handleErr],
  );

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string): Promise<'ok' | 'error' | 'redirect'> {
    const seq = ++detailSeq.current;
    setError('');
    setDetailLoading(true);
    try {
      const data = await getAdminTenant(id);
      // 过期请求不写状态、不报错
      if (seq !== detailSeq.current) return 'ok';
      setDetail(data);
      setAmount('');
      setNote('');
      return 'ok';
    } catch (err) {
      if (seq !== detailSeq.current) return 'ok';
      return handleErr(err) ? 'redirect' : 'error';
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }

  async function refreshAfterWrite(tenantId: string) {
    // 写操作已成功，先给出明确的成功提示，避免刷新失败被误判为操作失败
    setNotice('操作已成功，正在刷新数据…');
    const detailResult = await openDetail(tenantId);
    if (detailResult === 'redirect') return;
    // 详情刷新失败也要继续补刷新列表，保证后台数据尽量一致
    const listOk = await loadRef.current({ preserveError: true });
    setNotice(
      detailResult === 'ok' && listOk
        ? '操作已成功。'
        : '操作已成功，但数据刷新失败，请勿重复提交；稍后可手动刷新页面确认。',
    );
  }

  function closeDetail() {
    detailSeq.current += 1;
    setDetail(null);
    setAmount('');
    setNote('');
    setDetailLoading(false);
  }

  async function subscribe(tenantId: string, tenantName: string, plan: string) {
    if (inFlight.current) return;
    if (!plan) return;
    const planName = plans.find((p) => p.id === plan)?.name ?? plan;
    if (!window.confirm(`确认给 ${tenantName} 开通套餐 ${planName}？`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminSubscribeTenant(tenantId, { planId: plan });
      await refreshAfterWrite(tenantId);
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function adjust(tenantId: string, tenantName: string) {
    if (inFlight.current) return;
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value === 0) {
      setError('请输入非零整数积分');
      return;
    }
    if (!window.confirm(`确认调整 ${tenantName} 的积分 ${value}？\n备注：${note.trim() || '—'}`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminAdjustCredits(tenantId, { amount: value, note });
      setAmount('');
      setNote('');
      await refreshAfterWrite(tenantId);
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
            <h1 className="page-title">会员管理</h1>
            <p className="page-sub">跨租户查看订阅与积分，并代运营开通套餐、调整额度。</p>
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
            placeholder="搜索租户名"
            value={q}
            onChange={(e) => { setPage(1); setQ(e.target.value); }}
          />
          <select className="admin-input" value={planId} onChange={(e) => { setPage(1); setPlanId(e.target.value); }}>
            <option value="">全部套餐</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {detailLoading && <div className="admin-empty">详情加载中…</div>}

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">{detail.name}</h2>
            <p className="admin-muted">
              套餐 {detail.planName} · 状态 {detail.subscriptionStatus} · 可用 {detail.balance} · 预占 {detail.reserved}
              {' '}· 用户 {detail.userCount} · 会话 {detail.sessionCount}
            </p>
            <div className="admin-form">
              <label className="admin-field">
                开通套餐
                <select
                  className="admin-input"
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => {
                    if (busy) return;
                    const value = e.currentTarget.value;
                    e.currentTarget.value = '';
                    void subscribe(detail.id, detail.name, value);
                  }}
                >
                  <option value="">选择套餐…</option>
                  {plans.filter((p) => p.id !== 'free').map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                调整积分（正负整数）
                <input className="admin-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="admin-field">
                备注
                <input className="admin-input" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button
                type="button"
                className="admin-btn primary"
                disabled={busy}
                onClick={() => void adjust(detail.id, detail.name)}
              >
                提交调整
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
          <div className="admin-empty">没有匹配的租户</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>租户</th>
                <th>套餐</th>
                <th>状态</th>
                <th>可用积分</th>
                <th>预占</th>
                <th>用户数</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.planName}</td>
                  <td>{t.subscriptionStatus}</td>
                  <td className="numeric">{t.balance}</td>
                  <td className="numeric">{t.reserved}</td>
                  <td className="numeric">{t.userCount}</td>
                  <td>{new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button type="button" className="admin-btn" onClick={() => void openDetail(t.id)}>
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
