'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminMetricTimeseriesDto,
  AdminOverviewDto,
  AdminOverviewRange,
} from '@ai-office/shared';
import {
  adminErrorText,
  getAdminMetricTimeseries,
  getAdminOverview,
  isForbidden,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';
import {
  formatCompact,
  formatDuration,
} from '../../../components/chart-geometry';
import { LineChart, StackedBarChart } from '../../../components/metric-chart';

const RANGES: Array<{ value: AdminOverviewRange; label: string }> = [
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

const RANGE_MS: Record<AdminOverviewRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const HEALTH_NAMES: Record<string, string> = {
  db: '数据库',
  redis: '缓存',
  runtime: '运行时',
};

function bucketLabel(iso: string, range: AdminOverviewRange): string {
  const date = new Date(iso);
  return range === '24h'
    ? date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function deltaText(current: number, previous: number): string {
  if (!Number.isFinite(previous) || previous <= 0) return '较上一周期 —';
  const diff = ((current - previous) / previous) * 100;
  return `较上一周期 ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`;
}

/** 后端把尾部维度合并成 other；空维度只可能来自 global 序列。 */
function dimensionName(id: string): string {
  if (id === '') return '全部';
  if (id === 'other') return '其他';
  return id;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export default function AdminOverviewPage() {
  const router = useRouter();
  const [range, setRange] = useState<AdminOverviewRange>('24h');
  const [overview, setOverview] = useState<AdminOverviewDto | null>(null);
  const [credits, setCredits] = useState<AdminMetricTimeseriesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

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

  const seq = useRef(0);
  const load = useCallback(
    async (silent = false) => {
      const id = ++seq.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const end = new Date();
        const start = new Date(end.getTime() - RANGE_MS[range]);
        const [nextOverview, nextCredits] = await Promise.all([
          getAdminOverview(range),
          getAdminMetricTimeseries({
            metrics: 'credits',
            from: start.toISOString(),
            to: end.toISOString(),
            granularity: range === '24h' ? 'hour' : 'day',
            dimensionType: 'model',
          }),
        ]);
        // 切换范围或自动刷新交错时，只让最后一次请求写状态。
        if (id !== seq.current) return;
        setOverview(nextOverview);
        setCredits(nextCredits);
      } catch (err) {
        if (id !== seq.current) return;
        handleErr(err);
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [range, handleErr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 每 60 秒静默刷新；标签页隐藏时跳过，重新可见时立即补一次。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const points = overview?.series ?? [];
  const labels = points.map((point) => bucketLabel(point.bucketStart, overview?.range ?? range));
  const creditLabels = (credits?.series[0]?.points ?? []).map((point) =>
    bucketLabel(point.bucketStart, range),
  );
  const creditSeries = (credits?.series ?? []).map((item) => ({
    name: dimensionName(item.dimensionId),
    values: item.points.map((point) => point.value),
  }));
  const modelCostTotal = (overview?.modelCosts ?? []).reduce(
    (sum, item) => sum + item.credits,
    0,
  );

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">运行概览</h1>
            <p className="page-sub">运营指标、成本与告警态势；每 60 秒自动刷新。</p>
          </div>
          <div className="page-head-actions">
            <div className="overview-range" role="group" aria-label="时间范围">
              {RANGES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`admin-btn${range === item.value ? ' primary' : ''}`}
                  aria-pressed={range === item.value}
                  onClick={() => setRange(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading && !overview ? (
          <div className="admin-empty">加载中…</div>
        ) : !overview ? (
          <div className="admin-empty">{error ? '加载失败' : '暂无数据'}</div>
        ) : (
          <>
            <section className="kpi-grid" aria-label="核心指标" aria-busy={loading}>
              <Kpi
                label="运行总数"
                value={formatCompact(overview.current.runs)}
                hint={deltaText(overview.current.runs, overview.previous.runs)}
              />
              <Kpi
                label="成功率"
                value={percent(overview.current.successRate)}
                hint={`${overview.current.failedRuns} 次失败`}
              />
              <Kpi
                label="输入 Token"
                value={formatCompact(overview.current.inputTokens)}
                hint={deltaText(overview.current.inputTokens, overview.previous.inputTokens)}
              />
              <Kpi
                label="输出 Token"
                value={formatCompact(overview.current.outputTokens)}
                hint={deltaText(overview.current.outputTokens, overview.previous.outputTokens)}
              />
              <Kpi
                label="积分消耗"
                value={formatCompact(overview.current.credits)}
                hint={deltaText(overview.current.credits, overview.previous.credits)}
              />
              <Kpi
                label="平均运行时长"
                value={formatDuration(overview.current.avgDurationMs)}
                hint={`P95 ${formatDuration(overview.current.p95DurationMs)}`}
              />
              <Kpi
                label="未恢复告警"
                value={String(overview.current.unresolvedAlerts)}
                hint="全部时间"
              />
            </section>

            <section className="overview-grid" aria-label="趋势图">
              <LineChart
                title="运行量与失败量"
                labels={labels}
                series={[
                  { name: '运行', values: points.map((point) => point.runs) },
                  { name: '失败', values: points.map((point) => point.failedRuns) },
                ]}
              />
              <LineChart
                title="Token 消耗"
                labels={labels}
                series={[
                  { name: '输入', values: points.map((point) => point.inputTokens) },
                  { name: '输出', values: points.map((point) => point.outputTokens) },
                ]}
              />
              {creditSeries.length === 0 || creditLabels.length === 0 ? (
                <figure className="chart">
                  <figcaption className="chart-title">积分消耗（按模型堆叠）</figcaption>
                  <div className="admin-empty">该区间暂无按模型统计的积分数据</div>
                </figure>
              ) : (
                <StackedBarChart
                  title="积分消耗（按模型堆叠）"
                  labels={creditLabels}
                  series={creditSeries}
                />
              )}
              <LineChart
                title="平均运行时长"
                labels={labels}
                series={[
                  {
                    name: '平均时长',
                    values: points.map((point) => point.avgDurationMs ?? 0),
                  },
                ]}
                formatValue={formatDuration}
              />
            </section>

            <section className="overview-grid" aria-label="成本与健康">
              <section className="admin-panel">
                <h2 className="billing-heading">模型积分分布</h2>
                {overview.modelCosts.length === 0 ? (
                  <div className="admin-empty">暂无数据</div>
                ) : (
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th className="numeric">积分</th>
                        <th className="numeric">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.modelCosts.map((item) => (
                        <tr key={item.model}>
                          <td>{item.model}</td>
                          <td className="numeric">{formatCompact(item.credits)}</td>
                          <td className="numeric">
                            {modelCostTotal > 0
                              ? `${((item.credits / modelCostTotal) * 100).toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="admin-panel">
                <h2 className="billing-heading">服务健康</h2>
                {overview.serviceHealth.length === 0 ? (
                  <div className="admin-empty">暂无数据</div>
                ) : (
                  <ul className="health-list">
                    {overview.serviceHealth.map((item) => (
                      <li key={item.name} className="health-item">
                        <span
                          className={`health-dot${item.up ? ' up' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="health-name">
                          {HEALTH_NAMES[item.name] ?? item.name}
                        </span>
                        <span className="health-state">{item.up ? '正常' : '异常'}</span>
                        <span className="admin-muted">
                          {new Date(item.checkedAt).toLocaleTimeString('zh-CN', {
                            hour12: false,
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </section>

            <p className="admin-muted" aria-live="polite">
              {refreshing
                ? '正在刷新…'
                : `数据生成于 ${new Date(overview.generatedAt).toLocaleString('zh-CN', {
                    hour12: false,
                  })}`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
