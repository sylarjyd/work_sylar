'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  BillingSummaryDto,
  CreditLedgerItemDto,
  PlanDto,
  UsageAggregateDto,
} from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import {
  getBillingSummary,
  getToken,
  getUsage,
  isUnauthorized,
  listCreditLedger,
  listPlans,
} from '../../lib/api';
import { errorText } from '../../lib/errors';

const TYPE_LABEL: Record<string, string> = {
  grant: '发放',
  consume: '消耗',
  expire: '过期',
  adjust: '调整',
  refund: '退款',
};

function money(cents: number): string {
  if (cents === 0) return '免费';
  const yuan = (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `¥${yuan}/月`;
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export default function BillingPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<BillingSummaryDto | null>(null);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerItemDto[]>([]);
  const [usage, setUsage] = useState<UsageAggregateDto[]>([]);
  const [groupBy, setGroupBy] = useState<'day' | 'model'>('day');
  const [error, setError] = useState('');
  const [loadingBase, setLoadingBase] = useState(true);
  const [loadingUsage, setLoadingUsage] = useState(true);
  // 递增序号：只接受最新一次 usage 请求的结果，避免快速切换 tab 时旧响应覆盖新数据。
  const usageSeq = useRef(0);

  const loadBase = useCallback(async () => {
    setError('');
    setLoadingBase(true);
    try {
      const [s, p, l] = await Promise.allSettled([
        getBillingSummary(),
        listPlans(),
        listCreditLedger(30),
      ]);
      if (s.status === 'fulfilled') setSummary(s.value);
      if (p.status === 'fulfilled') setPlans(p.value);
      if (l.status === 'fulfilled') setLedger(l.value.items);

      const failures = [s, p, l].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      if (failures.length > 0) {
        if (failures.some((f) => isUnauthorized(f.reason))) {
          router.push('/login');
          return;
        }
        // 多个接口同时失败时只展示第一条，避免错误横幅过长。
        setError(errorText(failures[0].reason));
      }
    } finally {
      setLoadingBase(false);
    }
  }, [router]);

  const loadUsage = useCallback(
    async (group: 'day' | 'model') => {
      const id = ++usageSeq.current;
      setError('');
      setLoadingUsage(true);
      try {
        const u = await getUsage(group);
        if (id !== usageSeq.current) return;
        setUsage(u);
      } catch (err) {
        if (id !== usageSeq.current) return;
        if (isUnauthorized(err)) {
          router.push('/login');
          return;
        }
        setError(errorText(err));
      } finally {
        if (id === usageSeq.current) setLoadingUsage(false);
      }
    },
    [router],
  );

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void loadBase();
  }, [loadBase, router]);

  useEffect(() => {
    // 登录态检查由上面的挂载 effect 负责，这里只在已登录时拉取用量。
    if (!getToken()) return;
    void loadUsage(groupBy);
  }, [loadUsage, router, groupBy]);

  const quota = summary
    ? summary.plan.monthlyBaseCredits + summary.plan.monthlyBonusCredits
    : 0;
  const percent = quota > 0 && summary ? Math.min(100, Math.round((summary.balance / quota) * 100)) : 0;

  return (
    <AppShell active="billing">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">套餐与用量</h1>
              <p className="page-sub">积分按模型 token 折算，每月到期作废、不结转。</p>
            </div>
            {summary && (
              <div className="page-head-actions">
                <span className={`status ${summary.subscription.status === 'active' ? 'status-ready' : 'status-failed'}`}>
                  {summary.subscription.status === 'active' ? '生效中' : '已过期'}
                </span>
              </div>
            )}
          </header>

          {error && (
            <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          {summary && (
            <section className="billing-grid">
              <div className="billing-card billing-card-main">
                <div className="billing-label">当前套餐</div>
                <div className="billing-plan">{summary.plan.name}</div>
                <div className="billing-sub">
                  周期 {stamp(summary.subscription.periodStart)} — {stamp(summary.subscription.periodEnd)}
                </div>
                <div
                  className="billing-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label="本周期剩余积分进度"
                >
                  <div className="billing-bar-fill" style={{ width: `${percent}%` }} />
                </div>
                <div className="billing-sub">
                  可用 {summary.balance} 积分{summary.reserved > 0 ? ` · 已预占 ${summary.reserved}` : ''}
                </div>
              </div>
              <div className="billing-card">
                <div className="billing-label">本周期额度</div>
                <div className="billing-stat">{quota}</div>
                <div className="billing-sub">
                  基础 {summary.plan.monthlyBaseCredits} + 赠送 {summary.plan.monthlyBonusCredits}
                </div>
              </div>
              <div className="billing-card">
                <div className="billing-label">最近到期</div>
                <div className="billing-stat">{summary.nextExpiry ? summary.nextExpiry.amount : 0}</div>
                <div className="billing-sub">
                  {summary.nextExpiry ? stamp(summary.nextExpiry.expiresAt) : '无到期积分'}
                </div>
              </div>
            </section>
          )}

          <section className="billing-section">
            <h2 className="billing-heading">套餐目录</h2>
            <div className="billing-plans">
              {plans.map((p) => (
                <div key={p.id} className={`billing-card${summary?.plan.id === p.id ? ' current' : ''}`}>
                  <div className="billing-plan">{p.name}</div>
                  <div className="billing-price">{money(p.priceCents)}</div>
                  <ul className="billing-list">
                    <li>每月 {p.monthlyBaseCredits + p.monthlyBonusCredits} 积分</li>
                    <li>单次最多 {p.maxCreditsPerRun} 积分</li>
                    <li>每分钟 {p.rpm} 次运行</li>
                    <li>模型：{p.allowedModels.join('、')}</li>
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section className="billing-section">
            <div className="billing-section-head">
              <h2 className="billing-heading">用量</h2>
              <div className="billing-tabs" role="tablist" aria-label="用量分组">
                <button
                  type="button"
                  role="tab"
                  aria-selected={groupBy === 'day'}
                  className={`billing-tab${groupBy === 'day' ? ' active' : ''}`}
                  onClick={() => setGroupBy('day')}
                >
                  按日
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={groupBy === 'model'}
                  className={`billing-tab${groupBy === 'model' ? ' active' : ''}`}
                  onClick={() => setGroupBy('model')}
                >
                  按模型
                </button>
              </div>
            </div>
            {loadingUsage && usage.length > 0 && (
              <div className="billing-sub" role="status" style={{ marginBottom: 8 }}>
                加载中…
              </div>
            )}
            {usage.length === 0 && loadingUsage ? (
              <div className="billing-empty">加载中…</div>
            ) : usage.length === 0 ? (
              <div className="billing-empty">暂无用量记录</div>
            ) : (
              <table className="billing-table">
                <caption className="visually-hidden">
                  用量统计（{groupBy === 'day' ? '按日' : '按模型'}）
                </caption>
                <thead>
                  <tr>
                    <th>{groupBy === 'day' ? '日期' : '模型'}</th>
                    <th>运行次数</th>
                    <th>输入 token</th>
                    <th>输出 token</th>
                    <th>积分</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.key}>
                      <td>{u.key}</td>
                      <td>{u.runs}</td>
                      <td>{u.inputTokens}</td>
                      <td>{u.outputTokens}</td>
                      <td>{u.credits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="billing-section">
            <h2 className="billing-heading">积分流水</h2>
            {ledger.length === 0 && loadingBase ? (
              <div className="billing-empty">加载中…</div>
            ) : ledger.length === 0 ? (
              <div className="billing-empty">暂无流水</div>
            ) : (
              <table className="billing-table">
                <caption className="visually-hidden">最近 30 条积分流水</caption>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>来源</th>
                    <th>数量</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((t) => (
                    <tr key={t.id}>
                      <td>{stamp(t.createdAt)}</td>
                      <td>{TYPE_LABEL[t.type] ?? t.type}</td>
                      <td>{t.source ?? '—'}</td>
                      <td className={t.amount < 0 ? 'billing-negative' : 'billing-positive'}>
                        {t.amount > 0 ? `+${t.amount}` : t.amount}
                      </td>
                      <td>{t.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
