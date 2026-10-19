'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { isUnauthorized } from '../../../lib/api';

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
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [data, planRows] = await Promise.all([
        listAdminTenants({ page, pageSize: 20, q, planId }),
        listAdminPlans(),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setPlans(planRows.filter((p) => p.active));
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [page, q, planId, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setError('');
    try {
      setDetail(await getAdminTenant(id));
    } catch (err) {
      handleErr(err);
    }
  }

  async function subscribe(tenantId: string, plan: string) {
    if (!plan) return;
    if (!window.confirm(`确认为该租户开通套餐 ${plan}？`)) return;
    try {
      await adminSubscribeTenant(tenantId, { planId: plan });
      await openDetail(tenantId);
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  async function adjust(tenantId: string) {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value === 0) {
      setError('请输入非零整数积分');
      return;
    }
    if (!window.confirm(`确认调整积分 ${value}？\n备注：${note || '—'}`)) return;
    try {
      await adminAdjustCredits(tenantId, { amount: value, note });
      setAmount('');
      setNote('');
      await openDetail(tenantId);
      await load();
    } catch (err) {
      handleErr(err);
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
                  onChange={(e) => void subscribe(detail.id, e.target.value)}
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
              <button type="button" className="admin-btn primary" onClick={() => void adjust(detail.id)}>
                提交调整
              </button>
              <button type="button" className="admin-btn" onClick={() => setDetail(null)}>
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
