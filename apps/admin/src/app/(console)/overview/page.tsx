'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Card, Col, Row, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
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
import { clearToken, isUnauthorized } from '@ai-office/web-core';
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
    <Card size="small" style={{ height: '100%' }}>
      <Statistic title={label} value={value} valueStyle={{ fontSize: 24 }} />
      {hint ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      ) : null}
    </Card>
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
        router.replace('/login');
        return;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
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

  const modelCostColumns: TableColumnsType<AdminOverviewDto['modelCosts'][number]> = [
    { title: '模型', dataIndex: 'model' },
    {
      title: '积分',
      dataIndex: 'credits',
      align: 'right',
      render: (v: number) => formatCompact(v),
    },
    {
      title: '占比',
      key: 'share',
      align: 'right',
      render: (_: unknown, item) =>
        modelCostTotal > 0 ? `${((item.credits / modelCostTotal) * 100).toFixed(1)}%` : '—',
    },
  ];

  const healthColumns: TableColumnsType<AdminOverviewDto['serviceHealth'][number]> = [
    {
      title: '服务',
      dataIndex: 'name',
      render: (v: string) => HEALTH_NAMES[v] ?? v,
    },
    {
      title: '状态',
      dataIndex: 'up',
      render: (up: boolean) =>
        up ? <Tag color="success">正常</Tag> : <Tag color="error">异常</Tag>,
    },
    {
      title: '检查时间',
      dataIndex: 'checkedAt',
      render: (v: string) =>
        new Date(v).toLocaleTimeString('zh-CN', { hour12: false }),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            运行概览
          </Typography.Title>
          <Typography.Text type="secondary">
            运营指标、成本与告警态势；每 60 秒自动刷新。
          </Typography.Text>
        </div>
        <Segmented
          value={range}
          onChange={(value) => setRange(value as AdminOverviewRange)}
          options={RANGES.map((item) => ({ value: item.value, label: item.label }))}
        />
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      {loading && !overview ? (
        <Card loading />
      ) : !overview ? (
        <Card>
          <Typography.Text type="secondary">{error ? '加载失败' : '暂无数据'}</Typography.Text>
        </Card>
      ) : (
        <>
          <Row gutter={[12, 12]} aria-busy={loading}>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="运行总数"
                value={formatCompact(overview.current.runs)}
                hint={deltaText(overview.current.runs, overview.previous.runs)}
              />
            </Col>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="成功率"
                value={percent(overview.current.successRate)}
                hint={`${overview.current.failedRuns} 次失败`}
              />
            </Col>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="输入 Token"
                value={formatCompact(overview.current.inputTokens)}
                hint={deltaText(overview.current.inputTokens, overview.previous.inputTokens)}
              />
            </Col>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="输出 Token"
                value={formatCompact(overview.current.outputTokens)}
                hint={deltaText(overview.current.outputTokens, overview.previous.outputTokens)}
              />
            </Col>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="积分消耗"
                value={formatCompact(overview.current.credits)}
                hint={deltaText(overview.current.credits, overview.previous.credits)}
              />
            </Col>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="平均运行时长"
                value={formatDuration(overview.current.avgDurationMs)}
                hint={`P95 ${formatDuration(overview.current.p95DurationMs)}`}
              />
            </Col>
            <Col xs={12} sm={8} xl={6}>
              <Kpi
                label="未恢复告警"
                value={String(overview.current.unresolvedAlerts)}
                hint="全部时间"
              />
            </Col>
          </Row>

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

          <Row gutter={[12, 12]}>
            <Col xs={24} xl={12}>
              <Card title="模型积分分布" size="small">
                <Table<AdminOverviewDto['modelCosts'][number]>
                  rowKey="model"
                  size="small"
                  columns={modelCostColumns}
                  dataSource={overview.modelCosts}
                  pagination={false}
                  locale={{ emptyText: '暂无数据' }}
                />
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card title="服务健康" size="small">
                <Table<AdminOverviewDto['serviceHealth'][number]>
                  rowKey="name"
                  size="small"
                  columns={healthColumns}
                  dataSource={overview.serviceHealth}
                  pagination={false}
                  locale={{ emptyText: '暂无数据' }}
                />
              </Card>
            </Col>
          </Row>

          <Typography.Text type="secondary" aria-live="polite">
            {refreshing
              ? '正在刷新…'
              : `数据生成于 ${new Date(overview.generatedAt).toLocaleString('zh-CN', {
                  hour12: false,
                })}`}
          </Typography.Text>
        </>
      )}
    </Space>
  );
}
