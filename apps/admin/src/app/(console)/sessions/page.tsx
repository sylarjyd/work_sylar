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
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminMessageDto, AdminSessionDetailDto, AdminSessionItemDto } from '@ai-office/shared';
import {
  adminErrorText,
  archiveAdminSession,
  fetchAdminAttachmentBlob,
  getAdminSession,
  isForbidden,
  listAdminMessages,
  listAdminSessions,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';
import { FilePreviewDialog, type PreviewTarget } from '@ai-office/web-core/file-preview';

const PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 50;

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function statusTag(status: AdminSessionItemDto['status']) {
  return status === 'archived' ? <Tag>已归档</Tag> : <Tag color="success">活跃</Tag>;
}

export default function AdminSessionsPage() {
  const router = useRouter();
  const { modal } = App.useApp();
  const [items, setItems] = useState<AdminSessionItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [userId, setUserId] = useState('');
  const [detail, setDetail] = useState<AdminSessionDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [messages, setMessages] = useState<AdminMessageDto[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  // 消息归属的会话；仅当其与当前详情一致时才展示消息，避免旧消息挂到新详情下
  const [messagesFor, setMessagesFor] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  // 附件在线预览：Blob 由管理员会话取回，查看器不接触 JWT。
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [previewingId, setPreviewingId] = useState('');

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

  const loadSeq = useRef(0);
  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminSessions({
        page,
        pageSize: PAGE_SIZE,
        q,
        status,
        tenantId,
        userId,
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
  }, [page, q, status, tenantId, userId, handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const detailSeq = useRef(0);
  const messageSeq = useRef(0);

  const loadMessages = useCallback(
    async (id: string, targetPage: number): Promise<boolean> => {
      const seq = ++messageSeq.current;
      setMessagesLoading(true);
      try {
        const data = await listAdminMessages(id, { page: targetPage, pageSize: MESSAGE_PAGE_SIZE });
        // 过期响应不写状态（切换会话或翻页已产生新请求）
        if (seq !== messageSeq.current) return true;
        setMessages(data.items);
        setMessageTotal(data.total);
        setMessagePage(targetPage);
        setMessagesFor(id);
        return true;
      } catch (err) {
        if (seq !== messageSeq.current) return true;
        return !handleErr(err);
      } finally {
        if (seq === messageSeq.current) setMessagesLoading(false);
      }
    },
    [handleErr],
  );

  async function openDetail(id: string) {
    const seq = ++detailSeq.current;
    // 作废旧会话的在途消息请求，并清空消息区，避免「新详情 + 旧消息」
    messageSeq.current++;
    setMessages([]);
    setMessageTotal(0);
    setMessagePage(1);
    setMessagesFor(null);
    setMessagesLoading(false);
    setError('');
    setDetailLoading(true);
    try {
      const data = await getAdminSession(id);
      if (seq !== detailSeq.current) return;
      setDetail(data);
      void loadMessages(id, 1);
    } catch (err) {
      if (seq !== detailSeq.current) return;
      handleErr(err);
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }

  function closeDetail() {
    // 递增序号让在途的详情/消息请求失效
    detailSeq.current++;
    messageSeq.current++;
    setDetail(null);
    setDetailLoading(false);
    setMessages([]);
    setMessageTotal(0);
    setMessagePage(1);
    setMessagesFor(null);
    setMessagesLoading(false);
  }

  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  function archive(item: AdminSessionItemDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认归档会话',
      content: `确认归档会话「${item.title}」？归档后普通用户不可见且不可恢复。`,
      okText: '归档',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runArchive(item),
    });
  }

  async function runArchive(item: AdminSessionItemDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await archiveAdminSession(item.id);
      // 功能性更新：只更新当前详情，避免旧闭包覆盖用户随后打开的其它会话。
      setDetail((d) => (d && d.id === item.id ? { ...d, status: 'archived' } : d));
      // 写操作已成功，先给出明确提示，避免补刷新失败被误判为写失败而重复提交
      setNotice('操作已成功，正在刷新数据…');
      const ok = await loadRef.current();
      setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const columns: TableColumnsType<AdminSessionItemDto> = [
    { title: '标题', dataIndex: 'title', ellipsis: true },
    { title: '用户', dataIndex: 'userEmail', width: 200, ellipsis: true },
    { title: '租户', dataIndex: 'tenantId', width: 240, ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: AdminSessionItemDto['status']) => statusTag(v),
    },
    { title: '消息', dataIndex: 'messageCount', align: 'right', width: 90 },
    { title: '任务', dataIndex: 'taskCount', align: 'right', width: 90 },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, s) => (
        <Space size={4}>
          <Button size="small" disabled={busy} onClick={() => void openDetail(s.id)}>
            查看
          </Button>
          <Button
            size="small"
            disabled={busy || s.status === 'archived'}
            onClick={() => archive(s)}
          >
            归档
          </Button>
        </Space>
      ),
    },
  ];

  async function openAttachment(id: string, filename: string) {
    if (previewingId) return;
    setPreviewingId(id);
    try {
      const blob = await fetchAdminAttachmentBlob(id);
      setPreview({ blob, name: filename });
    } catch (err) {
      handleErr(err);
    } finally {
      setPreviewingId('');
    }
  }

  const messageColumns: TableColumnsType<AdminMessageDto> = [
    { title: 'seq', dataIndex: 'seq', width: 70, align: 'right' },
    { title: '角色', dataIndex: 'role', width: 100 },
    {
      title: '内容',
      dataIndex: 'content',
      render: (v: string) => (
        <Typography.Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{v}</Typography.Text>
      ),
    },
    {
      title: '附件',
      key: 'attachments',
      width: 220,
      render: (_: unknown, m) =>
        m.attachments.length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          <Space direction="vertical" size={4}>
            {m.attachments.map((a) => (
              <Button
                key={a.id}
                size="small"
                loading={previewingId === a.id}
                onClick={() => void openAttachment(a.id, a.filename)}
              >
                {a.filename}
              </Button>
            ))}
          </Space>
        ),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          会话管理
        </Typography.Title>
        <Typography.Text type="secondary">跨租户查看会话与消息；归档为不可恢复操作。</Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}

      <Card
        title={
          <Space wrap>
            <Input
              allowClear
              placeholder="标题"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
              style={{ width: 180 }}
            />
            <Input
              allowClear
              placeholder="租户 ID"
              value={tenantId}
              onChange={(e) => {
                setPage(1);
                setTenantId(e.target.value);
              }}
              style={{ width: 220 }}
            />
            <Input
              allowClear
              placeholder="用户 ID"
              value={userId}
              onChange={(e) => {
                setPage(1);
                setUserId(e.target.value);
              }}
              style={{ width: 220 }}
            />
            <Select
              value={status}
              onChange={(v) => {
                setPage(1);
                setStatus(v);
              }}
              style={{ width: 130 }}
              options={[
                { value: '', label: '全部状态' },
                { value: 'active', label: '活跃' },
                { value: 'archived', label: '已归档' },
              ]}
            />
          </Space>
        }
        extra={<Typography.Text type="secondary">共 {total} 条</Typography.Text>}
      >
        <Table<AdminSessionItemDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1100 }}
          locale={{ emptyText: '没有匹配的会话' }}
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
        title={detail ? `会话详情 · ${detail.title}` : '会话详情'}
        width={900}
        open={detail !== null || detailLoading}
        onClose={closeDetail}
        destroyOnHidden
        loading={detailLoading}
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="用户">{detail.userEmail}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(detail.status)}</Descriptions.Item>
              <Descriptions.Item label="消息数">{detail.messageCount}</Descriptions.Item>
              <Descriptions.Item label="任务数">{detail.taskCount}</Descriptions.Item>
              <Descriptions.Item label="产物数">{detail.artifactCount}</Descriptions.Item>
            </Descriptions>

            {messagesFor === detail.id ? (
              <Table<AdminMessageDto>
                rowKey="id"
                size="small"
                loading={messagesLoading}
                columns={messageColumns}
                dataSource={messages}
                scroll={{ x: 760 }}
                locale={{ emptyText: '暂无消息' }}
                pagination={{
                  current: messagePage,
                  pageSize: MESSAGE_PAGE_SIZE,
                  total: messageTotal,
                  showSizeChanger: false,
                  showTotal: (t) => `共 ${t} 条`,
                  onChange: (p) => void loadMessages(detail.id, p),
                }}
              />
            ) : (
              <Typography.Text type="secondary">
                {messagesLoading ? '消息加载中…' : '消息加载失败，请重试'}
              </Typography.Text>
            )}
          </Space>
        ) : null}
      </Drawer>

      <FilePreviewDialog
        open={preview !== null}
        target={preview}
        onClose={() => setPreview(null)}
      />
    </Space>
  );
}
