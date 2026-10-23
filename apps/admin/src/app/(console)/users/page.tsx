'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminUserItemDto, AdminUserPatch } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminUsers,
  updateAdminUser,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

export default function AdminUsersPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<AdminUserItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminUsers({ page, pageSize: 20, q, status, role });
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setItems(data.items);
      setTotal(data.total);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      if (isUnauthorized(err)) {
        router.replace('/login');
        return false;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return false;
      }
      setError(adminErrorText(err));
      return false;
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, q, status, role, router]);

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // 防重提交：确认框之后、首个 await 之前占位，finally 复位。
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  function askPatch(user: AdminUserItemDto, body: AdminUserPatch) {
    const before = `角色 ${user.role} / 状态 ${user.status}`;
    const after = `角色 ${body.role ?? user.role} / 状态 ${body.status ?? user.status}`;
    modal.confirm({
      title: '确认修改用户',
      content: (
        <div>
          <div>{user.email}</div>
          <div style={{ color: '#8a958f' }}>
            {before} → {after}
          </div>
        </div>
      ),
      okText: '确认修改',
      cancelText: '取消',
      onOk: () => patch(user, body),
    });
  }

  async function patch(user: AdminUserItemDto, body: AdminUserPatch) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await updateAdminUser(user.id, body);
      // 写操作已成功，先给出明确提示，避免补刷新失败被误判为写失败而重复提交
      setNotice('操作已成功，正在刷新数据…');
      const ok = await loadRef.current();
      if (ok) {
        message.success('操作已成功');
        setNotice('');
      } else {
        setNotice('操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
      }
    } catch (err) {
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
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const columns: TableColumnsType<AdminUserItemDto> = [
    {
      title: '邮箱',
      dataIndex: 'email',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    { title: '租户', dataIndex: 'tenantName' },
    {
      title: '角色',
      dataIndex: 'role',
      render: (v: AdminUserItemDto['role']) =>
        v === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag>成员</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: AdminUserItemDto['status']) =>
        v === 'active' ? <Tag color="success">启用</Tag> : <Tag color="error">禁用</Tag>,
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, u) => (
        <Space size={4}>
          <Button
            size="small"
            disabled={busy}
            onClick={() =>
              askPatch(u, { status: u.status === 'active' ? 'disabled' : 'active' })
            }
          >
            {u.status === 'active' ? '禁用' : '启用'}
          </Button>
          <Button
            size="small"
            disabled={busy}
            onClick={() => askPatch(u, { role: u.role === 'admin' ? 'member' : 'admin' })}
          >
            {u.role === 'admin' ? '设为成员' : '设为管理员'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          用户管理
        </Typography.Title>
        <Typography.Text type="secondary">跨租户查看用户、状态与角色。</Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}

      <Card
        extra={
          <Typography.Text type="secondary">共 {total} 条</Typography.Text>
        }
        title={
          <Space wrap>
            <Input
              allowClear
              placeholder="搜索邮箱"
              value={q}
              disabled={busy}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
              style={{ width: 220 }}
            />
            <Select
              value={status}
              disabled={busy}
              onChange={(v) => {
                setPage(1);
                setStatus(v);
              }}
              style={{ width: 130 }}
              options={[
                { value: '', label: '全部状态' },
                { value: 'active', label: '启用' },
                { value: 'disabled', label: '禁用' },
              ]}
            />
            <Select
              value={role}
              disabled={busy}
              onChange={(v) => {
                setPage(1);
                setRole(v);
              }}
              style={{ width: 130 }}
              options={[
                { value: '', label: '全部角色' },
                { value: 'member', label: '成员' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Space>
        }
      >
        <Table<AdminUserItemDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 760 }}
          locale={{ emptyText: '没有匹配的用户' }}
          pagination={{
            current: page,
            pageSize: 20,
            total,
            showSizeChanger: false,
            onChange: setPage,
          }}
        />
      </Card>
    </Space>
  );
}
