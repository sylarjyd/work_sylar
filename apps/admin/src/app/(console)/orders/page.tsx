'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Card, Segmented, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminPlanOrderDto } from '@ai-office/shared';
import { adminErrorText, isForbidden, listAdminOrders } from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';
import { adminPagination, PAGE_SIZE_DEFAULT } from '../../../lib/pagination';

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  canceled: '已取消',
  refunded: '已退款',
};

function stamp(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export default function AdminOrdersPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminPlanOrderDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        clearToken();
        router.replace('/login');
        return;
      }
      if (isForbidden(err)) {
        setError('当前账号没有权限查看订单');
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
      const data = await listAdminOrders({ page, pageSize, status: status || undefined });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: TableColumnsType<AdminPlanOrderDto> = [
    { title: '下单时间', dataIndex: 'createdAt', width: 180, render: (v: string) => stamp(v) },
    { title: '用户', dataIndex: 'userEmail', ellipsis: true },
    { title: '租户', dataIndex: 'tenantName', ellipsis: true },
    { title: '套餐', dataIndex: 'planName', width: 160, ellipsis: true },
    {
      title: '金额',
      dataIndex: 'amountCents',
      width: 100,
      align: 'right',
      render: (v: number) => `¥${(v / 100).toFixed(2)}`,
    },
    { title: '渠道', dataIndex: 'provider', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'paid' ? 'success' : v === 'pending' ? 'processing' : 'default'}>
          {STATUS_LABEL[v] ?? v}
        </Tag>
      ),
    },
    { title: '支付时间', dataIndex: 'paidAt', width: 180, render: (v: string | null) => stamp(v) },
    {
      title: '订阅周期',
      key: 'period',
      width: 220,
      render: (_: unknown, row) =>
        row.periodStart && row.periodEnd
          ? `${stamp(row.periodStart)} ~ ${stamp(row.periodEnd)}`
          : '—',
    },
  ];

  return (
    <div>
      <div className="admin-page-head">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            订单管理
          </Typography.Title>
          <Typography.Text type="secondary">
            用户自服务订阅的支付订单；当前支付渠道为 mock，接入微信/支付宝后订单状态由回调驱动。
          </Typography.Text>
        </div>
        <Segmented
          value={status}
          onChange={(value) => {
            setStatus(String(value));
            setPage(1);
          }}
          options={[
            { value: '', label: '全部' },
            { value: 'pending', label: '待支付' },
            { value: 'paid', label: '已支付' },
          ]}
        />
      </div>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      <Card size="small" title="订单列表" extra={<Typography.Text type="secondary">共 {total} 条</Typography.Text>}>
        <Table<AdminPlanOrderDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1400 }}
          locale={{ emptyText: '暂无订单' }}
          pagination={adminPagination({
            page,
            pageSize,
            total,
            onChange: (nextPage, nextSize) => {
              setPage(nextSize === pageSize ? nextPage : 1);
              setPageSize(nextSize);
            },
          })}
        />
      </Card>
    </div>
  );
}
