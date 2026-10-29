'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminAssistantDto } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminAssistants,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;

const PERMISSION_LABELS: Record<string, string> = {
  standard: '标准',
  readonly: '只读',
  auto: '自动',
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 运营端助手列表：公共内置助手与用户自定义助手只读展示。 */
export default function AdminAssistantsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminAssistantDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<'all' | 'public' | 'personal'>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<AdminAssistantDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);

  const handleErr = useCallback(
    (err: unknown): void => {
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

  const load = useCallback(async (): Promise<void> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminAssistants({
        page,
        pageSize: PAGE_SIZE,
        ...(scope === 'all' ? {} : { scope }),
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      if (id !== loadSeq.current) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (id !== loadSeq.current) return;
      handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, scope, q, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: TableColumnsType<AdminAssistantDto> = [
    {
      title: '助手',
      dataIndex: 'name',
      width: 240,
      render: (_: unknown, item) => (
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis={{ tooltip: item.name }}>
            {item.name}
          </Typography.Text>
          {item.description ? (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block' }}
              ellipsis={{ tooltip: item.description }}
            >
              {item.description}
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '范围',
      dataIndex: 'scope',
      width: 100,
      render: (_: unknown, item) =>
        item.scope === 'public' ? <Tag color="green">公共内置</Tag> : <Tag>个人</Tag>,
    },
    {
      title: '创建者',
      dataIndex: 'ownerEmail',
      width: 200,
      ellipsis: true,
      render: (value: string | null) => value ?? '-',
    },
    {
      title: '绑定技能',
      dataIndex: 'skillNames',
      width: 240,
      render: (_: unknown, item) =>
        item.skillNames.length > 0 ? (
          <Space size={4} wrap>
            {item.skillNames.slice(0, 3).map((name) => (
              <Tag key={name}>{name}</Tag>
            ))}
            {item.skillNames.length > 3 ? <Tag>+{item.skillNames.length - 3}</Tag> : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">未绑定</Typography.Text>
        ),
    },
    {
      title: '工具',
      dataIndex: 'skills',
      width: 180,
      render: (_: unknown, item) =>
        item.skills.length > 0 ? item.skills.join(' / ') : '无限制',
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 150,
      ellipsis: true,
      render: (value: string | null) => value ?? '默认',
    },
    {
      title: '权限',
      dataIndex: 'permissionMode',
      width: 90,
      render: (value: string) => PERMISSION_LABELS[value] ?? value,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: string) => formatTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_: unknown, item) => (
        <Button size="small" onClick={() => setDetail(item)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          助手管理
        </Typography.Title>
        <Typography.Text type="secondary">
          公共内置助手对所有用户可见并可直接使用；个人助手只有创建者可见，运营端只读排查。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card
        title="助手列表"
        extra={
          <Space wrap>
            <Segmented
              value={scope}
              onChange={(value) => {
                setPage(1);
                setScope(value as 'all' | 'public' | 'personal');
              }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'public', label: '公共内置' },
                { value: 'personal', label: '个人' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="按名称/简介搜索"
              style={{ width: 220 }}
              onSearch={(value) => {
                setPage(1);
                setQ(value);
              }}
            />
          </Space>
        }
      >
        <Table<AdminAssistantDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1500 }}
          locale={{ emptyText: '暂无助手' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: setPage,
          }}
        />
      </Card>

      <Modal
        open={detail !== null}
        title={`助手详情 · ${detail?.name ?? ''}`}
        footer={null}
        width={720}
        onCancel={() => setDetail(null)}
      >
        {detail ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="范围">
              {detail.scope === 'public' ? '公共内置（所有用户可用）' : '个人（仅创建者）'}
            </Descriptions.Item>
            <Descriptions.Item label="创建者">{detail.ownerEmail ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="简介">{detail.description || '-'}</Descriptions.Item>
            <Descriptions.Item label="绑定技能">
              {detail.skillNames.length > 0 ? detail.skillNames.join('、') : '未绑定'}
            </Descriptions.Item>
            <Descriptions.Item label="工具">
              {detail.skills.length > 0 ? detail.skills.join(' / ') : '无限制'}
            </Descriptions.Item>
            <Descriptions.Item label="知识库">
              {detail.kbIds.length > 0 ? `${detail.kbIds.length} 个` : '全部知识库'}
            </Descriptions.Item>
            <Descriptions.Item label="默认模型">{detail.model ?? '默认'}</Descriptions.Item>
            <Descriptions.Item label="系统提示词">
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {detail.systemPrompt || '（空）'}
              </Typography.Paragraph>
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Modal>
    </Space>
  );
}
