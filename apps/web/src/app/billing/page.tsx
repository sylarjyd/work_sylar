'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
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
import { errorText } from '@ai-office/web-core';

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

function useUsageColumns(groupBy: 'day' | 'model'): TableColumnsType<UsageAggregateDto> {
  return [
    { title: groupBy === 'day' ? '日期' : '模型', dataIndex: 'key', ellipsis: true },
    { title: '运行次数', dataIndex: 'runs', width: 110, align: 'right' },
    { title: '输入 token', dataIndex: 'inputTokens', width: 130, align: 'right' },
    { title: '输出 token', dataIndex: 'outputTokens', width: 130, align: 'right' },
    { title: '积分', dataIndex: 'credits', width: 100, align: 'right' },
  ];
}

const ledgerColumns: TableColumnsType<CreditLedgerItemDto> = [
  {
    title: '时间',
    dataIndex: 'createdAt',
    width: 180,
    render: (v: string) => stamp(v),
  },
  {
    title: '类型',
    dataIndex: 'type',
    width: 90,
    render: (v: string) => TYPE_LABEL[v] ?? v,
  },
  {
    title: '来源',
    dataIndex: 'source',
    width: 140,
    render: (v: string | null) => v ?? '—',
  },
  {
    title: '数量',
    dataIndex: 'amount',
    width: 100,
    align: 'right',
    render: (v: number) => (
      <Typography.Text type={v < 0 ? 'danger' : 'success'}>
        {v > 0 ? `+${v}` : v}
      </Typography.Text>
    ),
  },
  {
    title: '备注',
    dataIndex: 'note',
    ellipsis: true,
    render: (v: string | null) => v ?? '—',
  },
];

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
            {summary ? (
              <div className="page-head-actions">
                <Tag color={summary.subscription.status === 'active' ? 'success' : 'error'}>
                  {summary.subscription.status === 'active' ? '生效中' : '已过期'}
                </Tag>
              </div>
            ) : null}
          </header>

          {error ? (
            <Alert
              type="error"
              showIcon
              message={error}
              closable
              onClose={() => setError('')}
              style={{ marginBottom: 16 }}
            />
          ) : null}

          {summary ? (
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col xs={24} md={10}>
                <Card size="small" title="当前套餐" style={{ height: '100%' }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Typography.Title level={4} style={{ margin: 0 }}>
                      {summary.plan.name}
                    </Typography.Title>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      周期 {stamp(summary.subscription.periodStart)} — {stamp(summary.subscription.periodEnd)}
                    </Typography.Text>
                    <Progress
                      percent={percent}
                      showInfo={false}
                      aria-label="本周期剩余积分进度"
                    />
                    <Typography.Text type="secondary">
                      可用 {summary.balance} 积分
                      {summary.reserved > 0 ? ` · 已预占 ${summary.reserved}` : ''}
                    </Typography.Text>
                  </Space>
                </Card>
              </Col>
              <Col xs={12} md={7}>
                <Card size="small" title="本周期额度" style={{ height: '100%' }}>
                  <Statistic value={quota} suffix="积分" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    基础 {summary.plan.monthlyBaseCredits} + 赠送 {summary.plan.monthlyBonusCredits}
                  </Typography.Text>
                </Card>
              </Col>
              <Col xs={12} md={7}>
                <Card size="small" title="最近到期" style={{ height: '100%' }}>
                  <Statistic value={summary.nextExpiry ? summary.nextExpiry.amount : 0} suffix="积分" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {summary.nextExpiry ? stamp(summary.nextExpiry.expiresAt) : '无到期积分'}
                  </Typography.Text>
                </Card>
              </Col>
            </Row>
          ) : null}

          <Card size="small" title="套餐目录" style={{ marginBottom: 16 }} loading={loadingBase && plans.length === 0}>
            {plans.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无套餐" />
            ) : (
              <Row gutter={[12, 12]}>
                {plans.map((p) => {
                  const current = summary?.plan.id === p.id;
                  return (
                    <Col key={p.id} xs={24} sm={12} lg={8}>
                      <Card
                        size="small"
                        style={{
                          height: '100%',
                          borderColor: current ? '#00b07b' : undefined,
                        }}
                        title={
                          <Space size={8}>
                            <Typography.Text strong>{p.name}</Typography.Text>
                            {current ? <Tag color="success">当前</Tag> : null}
                          </Space>
                        }
                        extra={<Typography.Text type="secondary">{money(p.priceCents)}</Typography.Text>}
                      >
                        <Space direction="vertical" size={4} style={{ fontSize: 13 }}>
                          <span>每月 {p.monthlyBaseCredits + p.monthlyBonusCredits} 积分</span>
                          <span>单次最多 {p.maxCreditsPerRun} 积分</span>
                          <span>每分钟 {p.rpm} 次运行</span>
                          <span>模型：{p.allowedModels.join('、')}</span>
                        </Space>
                      </Card>
                    </Col>
                  );
                })}
              </Row>
            )}
          </Card>

          <Card
            size="small"
            title="用量"
            style={{ marginBottom: 16 }}
            extra={
              <Segmented
                value={groupBy}
                onChange={(value) => setGroupBy(value as 'day' | 'model')}
                options={[
                  { value: 'day', label: '按日' },
                  { value: 'model', label: '按模型' },
                ]}
              />
            }
          >
            <Table<UsageAggregateDto>
              rowKey="key"
              size="small"
              loading={loadingUsage}
              columns={useUsageColumns(groupBy)}
              dataSource={usage}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              locale={{ emptyText: '暂无用量记录' }}
            />
          </Card>

          <Card size="small" title="积分流水" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>最近 30 条</Typography.Text>}>
            <Table<CreditLedgerItemDto>
              rowKey="id"
              size="small"
              loading={loadingBase && ledger.length === 0}
              columns={ledgerColumns}
              dataSource={ledger}
              scroll={{ x: 760 }}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              locale={{ emptyText: '暂无流水' }}
            />
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
