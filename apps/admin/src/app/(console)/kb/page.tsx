'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type {
  AdminKbBaseDetailDto,
  AdminKbBaseItemDto,
  AdminKbStatsDto,
  KbDocDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  deleteAdminKbBase,
  deleteAdminKbDoc,
  getAdminKbBase,
  getAdminKbStats,
  isForbidden,
  listAdminKbBases,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;
const DOC_PAGE_SIZE = 10;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function statusTag(status: KbDocDto['status']) {
  if (status === 'ready') return <Tag color="success">可检索</Tag>;
  if (status === 'pending') return <Tag color="processing">摄取中</Tag>;
  return <Tag color="error">失败</Tag>;
}

const EMPTY_STATS: AdminKbStatsDto = {
  baseCount: 0,
  docCount: 0,
  readyCount: 0,
  pendingCount: 0,
  failedCount: 0,
  chunkCount: 0,
  totalBytes: 0,
  tenantCount: 0,
};

export default function AdminKbPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();

  const [stats, setStats] = useState<AdminKbStatsDto>(EMPTY_STATS);
  const [items, setItems] = useState<AdminKbBaseItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const [tenantInput, setTenantInput] = useState('');
  const [q, setQ] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);

  const handleError = useCallback(
    (err: unknown): void => {
      if (isUnauthorized(err) || isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const loadStats = useCallback(async () => {
    try {
      setStats(await getAdminKbStats());
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  const load = useCallback(async () => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminKbBases({ page, pageSize: PAGE_SIZE, q, tenantId });
      if (id !== loadSeq.current) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (id !== loadSeq.current) return;
      handleError(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, q, tenantId, handleError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  function search() {
    setPage(1);
    setQ(qInput.trim());
    setTenantId(tenantInput.trim());
  }

  // ---------------------------------------------------------------- 详情
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminKbBaseDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [docPage, setDocPage] = useState(1);
  const detailSeq = useRef(0);

  const loadDetail = useCallback(
    async (id: string, nextDocPage: number) => {
      const seq = ++detailSeq.current;
      setDetailLoading(true);
      try {
        const data = await getAdminKbBase(id, {
          docPage: nextDocPage,
          docPageSize: DOC_PAGE_SIZE,
        });
        if (seq !== detailSeq.current) return;
        setDetail(data);
      } catch (err) {
        if (seq !== detailSeq.current) return;
        handleError(err);
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false);
      }
    },
    [handleError],
  );

  useEffect(() => {
    if (detailId) void loadDetail(detailId, docPage);
  }, [detailId, docPage, loadDetail]);

  function openDetail(item: AdminKbBaseItemDto) {
    setDetail(null);
    setDocPage(1);
    setDetailId(item.id);
  }

  function closeDetail() {
    detailSeq.current += 1;
    setDetailId(null);
    setDetail(null);
  }

  // ---------------------------------------------------------------- 防重提交
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function runWrite(fn: () => Promise<void>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      if (isUnauthorized(err) || isForbidden(err)) {
        clearToken();
        router.replace('/login');
      } else {
        setError(adminErrorText(err));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- 删除
  const [deleteTarget, setDeleteTarget] = useState<AdminKbBaseItemDto | null>(null);
  const [confirmName, setConfirmName] = useState('');

  function askDelete(item: AdminKbBaseItemDto) {
    setConfirmName('');
    setDeleteTarget(item);
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    if (confirmName.trim() !== target.name) {
      void message.error('请输入完整的知识库名称');
      return;
    }
    await runWrite(async () => {
      const result = await deleteAdminKbBase(target.id, { confirmName: target.name });
      setDeleteTarget(null);
      if (result.cleanupFailed > 0) {
        void message.warning(
          `知识库已删除，但有 ${result.cleanupFailed} 个存储对象清理失败，已记录审计`,
        );
      } else {
        void message.success(`已删除知识库「${target.name}」及其 ${result.deletedDocs} 篇文档`);
      }
      if (detailId === target.id) closeDetail();
      // 删除后当前页可能越界，回到第一页重新加载。
      setPage(1);
      await load();
      await loadStats();
    });
  }

  function askDeleteDoc(base: AdminKbBaseItemDto, doc: KbDocDto) {
    modal.confirm({
      title: '删除文档',
      content: `确认删除「${doc.filename}」？删除后切片立即不可检索，且无法恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () =>
        runWrite(async () => {
          const result = await deleteAdminKbDoc(base.id, doc.id, { confirmId: doc.id });
          if (result.cleanupFailed > 0) {
            void message.warning('文档已删除，但存储对象清理失败，已记录审计');
          } else {
            void message.success('文档已删除');
          }
          await loadDetail(base.id, docPage);
          await load();
          await loadStats();
        }),
    });
  }

  // ---------------------------------------------------------------- 表格
  const columns: TableColumnsType<AdminKbBaseItemDto> = [
    {
      title: '知识库',
      dataIndex: 'name',
      render: (_: unknown, row) => (
        <div>
          <Typography.Text strong>{row.name}</Typography.Text>
          {row.description ? (
            <div style={{ fontSize: 12, color: '#8a958f' }}>{row.description}</div>
          ) : null}
        </div>
      ),
    },
    { title: '所有者', dataIndex: 'userEmail', render: (v: string) => v || '—' },
    {
      title: '租户',
      dataIndex: 'tenantName',
      render: (_: unknown, row) => (
        <div>
          <div>{row.tenantName || '—'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.tenantId}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '文档',
      dataIndex: 'docCount',
      align: 'right',
      render: (v: number, row) => (
        <Space size={4} wrap>
          <span>{v}</span>
          {row.readyCount > 0 ? <Tag color="success">{row.readyCount} 就绪</Tag> : null}
          {row.pendingCount > 0 ? <Tag color="processing">{row.pendingCount} 摄取中</Tag> : null}
          {row.failedCount > 0 ? <Tag color="error">{row.failedCount} 失败</Tag> : null}
        </Space>
      ),
    },
    { title: '切片', dataIndex: 'chunkCount', align: 'right' },
    {
      title: '占用空间',
      dataIndex: 'totalBytes',
      align: 'right',
      render: (v: number) => formatBytes(v),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      render: (v: string) => formatTime(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row) => (
        <Space size={4}>
          <Button size="small" onClick={() => openDetail(row)}>
            详情
          </Button>
          <Button size="small" danger onClick={() => askDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const docColumns: TableColumnsType<KbDocDto> = [
    { title: '文件名', dataIndex: 'filename', ellipsis: true },
    { title: '类型', dataIndex: 'mime', width: 160, ellipsis: true },
    {
      title: '大小',
      dataIndex: 'size',
      align: 'right',
      render: (v: number) => formatBytes(v),
    },
    { title: '状态', dataIndex: 'status', render: (v: KbDocDto['status']) => statusTag(v) },
    { title: '切片', dataIndex: 'chunkCount', align: 'right' },
    {
      title: '错误',
      dataIndex: 'error',
      render: (v: string | null) =>
        v ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {v}
          </Typography.Text>
        ) : (
          '—'
        ),
    },
    { title: '上传时间', dataIndex: 'createdAt', render: (v: string) => formatTime(v) },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_: unknown, row) =>
        detail ? (
          <Button size="small" danger onClick={() => askDeleteDoc(detail, row)}>
            删除
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        {[
          ['知识库', stats.baseCount],
          ['文档', stats.docCount],
          ['可检索', stats.readyCount],
          ['摄取中', stats.pendingCount],
          ['失败', stats.failedCount],
          ['切片', stats.chunkCount],
          ['覆盖租户', stats.tenantCount],
        ].map(([label, value]) => (
          <Col key={String(label)} xs={12} sm={8} xl={3}>
            <Card size="small">
              <Statistic title={label} value={value as number} />
            </Card>
          </Col>
        ))}
        <Col xs={24} xl={3}>
          <Card size="small">
            <Statistic title="占用空间" value={formatBytes(stats.totalBytes)} />
          </Card>
        </Col>
      </Row>

      <Card
        title="知识库列表"
        extra={
          <Space>
            <Input
              allowClear
              placeholder="库名或所有者邮箱"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onPressEnter={search}
              style={{ width: 220 }}
            />
            <Input
              allowClear
              placeholder="租户 ID"
              value={tenantInput}
              onChange={(e) => setTenantInput(e.target.value)}
              onPressEnter={search}
              style={{ width: 180 }}
            />
            <Button type="primary" onClick={search}>
              查询
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void load();
                void loadStats();
              }}
            >
              刷新
            </Button>
          </Space>
        }
      >
        {error ? (
          <Typography.Text type="danger" style={{ display: 'block', marginBottom: 12 }}>
            {error}
          </Typography.Text>
        ) : null}
        <Table<AdminKbBaseItemDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1000 }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 个知识库`,
            onChange: setPage,
          }}
        />
      </Card>

      <Drawer
        title={detail ? `知识库详情 · ${detail.name}` : '知识库详情'}
        width={900}
        open={detailId !== null}
        onClose={closeDetail}
        destroyOnHidden
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="所有者">{detail.userEmail || '—'}</Descriptions.Item>
              <Descriptions.Item label="租户">
                {detail.tenantName}（{detail.tenantId}）
              </Descriptions.Item>
              <Descriptions.Item label="文档数">{detail.docCount}</Descriptions.Item>
              <Descriptions.Item label="切片数">{detail.chunkCount}</Descriptions.Item>
              <Descriptions.Item label="占用空间">{formatBytes(detail.totalBytes)}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{formatTime(detail.updatedAt)}</Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>
                {detail.description || '—'}
              </Descriptions.Item>
            </Descriptions>
            <Table<KbDocDto>
              rowKey="id"
              size="small"
              loading={detailLoading}
              columns={docColumns}
              dataSource={detail.docs.items}
              scroll={{ x: 800 }}
              pagination={{
                current: detail.docs.page,
                pageSize: DOC_PAGE_SIZE,
                total: detail.docs.total,
                showSizeChanger: false,
                showTotal: (t) => `共 ${t} 篇文档`,
                onChange: setDocPage,
              }}
            />
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title="删除知识库"
        open={deleteTarget !== null}
        okText="确认删除"
        okButtonProps={{ danger: true, disabled: busy }}
        cancelText="取消"
        onOk={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
        destroyOnHidden
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>
            将删除「{deleteTarget?.name}」及其全部文档与切片，并解除助手绑定。此操作不可恢复。
          </Typography.Text>
          <Typography.Text type="secondary">
            请输入知识库名称以确认：{deleteTarget?.name}
          </Typography.Text>
          <Input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            onPressEnter={() => void confirmDelete()}
            placeholder="输入完整库名"
            autoFocus
          />
        </Space>
      </Modal>
    </Space>
  );
}
