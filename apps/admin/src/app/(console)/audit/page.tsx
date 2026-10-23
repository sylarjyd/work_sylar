'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Card, Input, Space, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminAuditItemDto } from '@ai-office/shared';
import { adminErrorText, isForbidden, listAdminAudit } from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function AdminAuditPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminAuditItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [actorId, setActorId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);

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

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminAudit({
        page,
        pageSize: PAGE_SIZE,
        action,
        targetType,
        targetId,
        actorId,
      });
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
  }, [page, action, targetType, targetId, actorId, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: TableColumnsType<AdminAuditItemDto> = [
    { title: '时间', dataIndex: 'createdAt', width: 170, render: formatTime },
    { title: '操作人', dataIndex: 'actorEmail', width: 200, ellipsis: true },
    {
      title: '动作',
      dataIndex: 'action',
      width: 190,
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: '对象',
      key: 'target',
      width: 240,
      render: (_: unknown, row) => (row.targetId ? `${row.targetType}: ${row.targetId}` : row.targetType),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      render: (v: Record<string, unknown> | null) =>
        v ? (
          <Typography.Text code style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {JSON.stringify(v)}
          </Typography.Text>
        ) : (
          '—'
        ),
    },
    { title: 'IP', dataIndex: 'ip', width: 130, render: (v: string | null) => v || '—' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          审计日志
        </Typography.Title>
        <Typography.Text type="secondary">写操作与敏感查看记录；不含消息正文与密钥。</Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card
        title={
          <Space wrap>
            <Input
              placeholder="动作（如 user.update）"
              aria-label="动作"
              value={action}
              onChange={(e) => {
                setPage(1);
                setAction(e.target.value);
              }}
              style={{ width: 200 }}
            />
            <Input
              placeholder="对象类型"
              aria-label="对象类型"
              value={targetType}
              onChange={(e) => {
                setPage(1);
                setTargetType(e.target.value);
              }}
              style={{ width: 150 }}
            />
            <Input
              placeholder="对象 ID"
              aria-label="对象 ID"
              value={targetId}
              onChange={(e) => {
                setPage(1);
                setTargetId(e.target.value);
              }}
              style={{ width: 200 }}
            />
            <Input
              placeholder="操作人 ID"
              aria-label="操作人 ID"
              value={actorId}
              onChange={(e) => {
                setPage(1);
                setActorId(e.target.value);
              }}
              style={{ width: 180 }}
            />
          </Space>
        }
        extra={<Typography.Text type="secondary">共 {total} 条</Typography.Text>}
      >
        <Table<AdminAuditItemDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1100 }}
          locale={{ emptyText: '暂无审计记录' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: setPage,
          }}
        />
      </Card>
    </Space>
  );
}
