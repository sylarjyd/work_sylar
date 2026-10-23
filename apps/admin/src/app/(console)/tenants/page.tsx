'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
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

const PAGE_SIZE = 20;

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function AdminTenantsPage() {
  const router = useRouter();
  const { modal, message } = App.useApp();
  const [items, setItems] = useState<AdminTenantItemDto[]>([]);
  const [plans, setPlans] = useState<AdminPlanDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [planId, setPlanId] = useState('');
  const [detail, setDetail] = useState<AdminTenantDetailDto | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [planPick, setPlanPick] = useState<string | undefined>(undefined);
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
          listAdminTenants({ page, pageSize: PAGE_SIZE, q, planId }),
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

  function openDrawer(item: AdminTenantItemDto) {
    setDetail(null);
    setDetailId(item.id);
    void openDetail(item.id);
  }

  function closeDetail() {
    detailSeq.current += 1;
    setDetailId(null);
    setDetail(null);
    setAmount('');
    setNote('');
    setPlanPick(undefined);
    setDetailLoading(false);
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

  function subscribe(tenantId: string, tenantName: string, plan: string) {
    if (inFlight.current) return;
    setPlanPick(undefined);
    if (!plan) return;
    const planName = plans.find((p) => p.id === plan)?.name ?? plan;
    modal.confirm({
      title: '确认开通套餐',
      content: `确认给「${tenantName}」开通套餐「${planName}」？`,
      okText: '确认开通',
      cancelText: '取消',
      onOk: async () => {
        if (inFlight.current) return;
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
      },
    });
  }

  async function adjust(tenantId: string, tenantName: string) {
    if (inFlight.current) return;
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value === 0) {
      void message.error('请输入非零整数积分');
      return;
    }
    modal.confirm({
      title: '确认调整积分',
      content: (
        <div>
          <div>租户：{tenantName}</div>
          <div>调整：{value}</div>
          <div>备注：{note.trim() || '—'}</div>
        </div>
      ),
      okText: '确认调整',
      cancelText: '取消',
      onOk: async () => {
        if (inFlight.current) return;
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
      },
    });
  }

  const columns: TableColumnsType<AdminTenantItemDto> = [
    {
      title: '租户',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    { title: '套餐', dataIndex: 'planName' },
    { title: '状态', dataIndex: 'subscriptionStatus', width: 120 },
    { title: '可用积分', dataIndex: 'balance', align: 'right', width: 110 },
    { title: '预占', dataIndex: 'reserved', align: 'right', width: 100 },
    { title: '用户数', dataIndex: 'userCount', align: 'right', width: 100 },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_: unknown, t) => (
        <Button size="small" onClick={() => openDrawer(t)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          会员管理
        </Typography.Title>
        <Typography.Text type="secondary">
          跨租户查看订阅与积分，并代运营开通套餐、调整额度。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}

      <Card
        title={
          <Space wrap>
            <Input
              allowClear
              placeholder="搜索租户名"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
              style={{ width: 220 }}
            />
            <Select
              value={planId}
              onChange={(v) => {
                setPage(1);
                setPlanId(v);
              }}
              style={{ width: 160 }}
              options={[
                { value: '', label: '全部套餐' },
                ...plans.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </Space>
        }
        extra={<Typography.Text type="secondary">共 {total} 条</Typography.Text>}
      >
        <Table<AdminTenantItemDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 960 }}
          locale={{ emptyText: '没有匹配的租户' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: setPage,
          }}
        />
      </Card>

      <Drawer
        title={detail ? `会员详情 · ${detail.name}` : '会员详情'}
        width={640}
        open={detailId !== null}
        onClose={closeDetail}
        destroyOnHidden
        loading={detailLoading}
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="套餐">{detail.planName}</Descriptions.Item>
              <Descriptions.Item label="订阅状态">{detail.subscriptionStatus}</Descriptions.Item>
              <Descriptions.Item label="可用积分">{detail.balance}</Descriptions.Item>
              <Descriptions.Item label="预占">{detail.reserved}</Descriptions.Item>
              <Descriptions.Item label="用户数">{detail.userCount}</Descriptions.Item>
              <Descriptions.Item label="会话数">{detail.sessionCount}</Descriptions.Item>
            </Descriptions>

            <Card size="small" title="代运营操作">
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div>
                  <Typography.Text type="secondary">开通套餐</Typography.Text>
                  <Select
                    style={{ width: '100%', marginTop: 4 }}
                    value={planPick}
                    placeholder="选择套餐…"
                    disabled={busy}
                    onChange={(value) => {
                      if (busy || !value) return;
                      setPlanPick(value);
                      subscribe(detail.id, detail.name, value);
                    }}
                    options={plans
                      .filter((p) => p.id !== 'free')
                      .map((p) => ({ value: p.id, label: p.name }))}
                  />
                </div>
                <div>
                  <Typography.Text type="secondary">调整积分（正负整数）</Typography.Text>
                  <Input
                    style={{ marginTop: 4 }}
                    value={amount}
                    disabled={busy}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="例如 1000 或 -500"
                  />
                </div>
                <div>
                  <Typography.Text type="secondary">备注</Typography.Text>
                  <Input
                    style={{ marginTop: 4 }}
                    value={note}
                    disabled={busy}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="调整原因（可选）"
                  />
                </div>
                <Button
                  type="primary"
                  disabled={busy}
                  onClick={() => void adjust(detail.id, detail.name)}
                >
                  提交调整
                </Button>
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
