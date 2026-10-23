'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  getAdminRun,
  getAdminRunTimeline,
  getAdminTask,
  isForbidden,
  listAdminTasks,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';
import { formatDuration } from '../../../components/chart-geometry';
import {
  timelineKindLabel,
  timelineStatusLabel,
  timelineStatusTone,
} from '../../../lib/run-timeline';

const PAGE_SIZE = 20;
const STEP_PAGE_SIZE = 100;

const TIMELINE_COLOR: Record<'ok' | 'bad' | 'warn' | 'active', string> = {
  ok: 'green',
  bad: 'red',
  warn: 'orange',
  active: 'blue',
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function AdminTasksPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminTaskItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tenantId, setTenantId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<AdminTaskDetailDto | null>(null);
  const [run, setRun] = useState<AdminRunDetailDto | null>(null);
  const [timeline, setTimeline] = useState<AdminRunTimelineDto | null>(null);
  const [traceCopied, setTraceCopied] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

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
      const data = await listAdminTasks({
        page,
        pageSize: PAGE_SIZE,
        tenantId,
        sessionId,
        userId,
        status,
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
  }, [page, tenantId, sessionId, userId, status, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const taskSeq = useRef(0);
  const runSeq = useRef(0);

  async function openTask(id: string) {
    const seq = ++taskSeq.current;
    // 切换任务时让在途的任务/运行请求失效，并清空旧详情，避免「新任务详情 + 旧任务运行」
    runSeq.current++;
    setError('');
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setRunLoading(false);
    setTaskLoading(true);
    try {
      const data = await getAdminTask(id);
      if (seq !== taskSeq.current) return;
      setDetail(data);
    } catch (err) {
      if (seq !== taskSeq.current) return;
      handleErr(err);
    } finally {
      if (seq === taskSeq.current) setTaskLoading(false);
    }
  }

  function closeTask() {
    // 递增序号让在途的任务/运行请求失效
    taskSeq.current++;
    runSeq.current++;
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setTaskLoading(false);
    setRunLoading(false);
  }

  async function openRun(id: string) {
    const seq = ++runSeq.current;
    setError('');
    setTimeline(null);
    setTraceCopied(false);
    setRunLoading(true);
    try {
      // 时间线失败不应拖垮运行详情：两者独立结算，谁成功就先展示谁。
      const [runResult, timelineResult] = await Promise.allSettled([
        getAdminRun(id, { stepPage: 1, stepPageSize: STEP_PAGE_SIZE }),
        getAdminRunTimeline(id),
      ]);
      if (seq !== runSeq.current) return;
      if (runResult.status === 'rejected') {
        handleErr(runResult.reason);
        return;
      }
      setRun(runResult.value);
      if (timelineResult.status === 'fulfilled') {
        setTimeline(timelineResult.value);
      } else {
        handleErr(timelineResult.reason);
      }
    } catch (err) {
      if (seq !== runSeq.current) return;
      handleErr(err);
    } finally {
      if (seq === runSeq.current) setRunLoading(false);
    }
  }

  // 复制失败（非 HTTPS、权限拒绝）时退回手动选择，不阻断时间线展示。
  async function copyTrace(traceId: string) {
    try {
      await navigator.clipboard.writeText(traceId);
      setTraceCopied(true);
    } catch {
      setError('复制失败，请手动选择 traceId');
    }
  }

  const columns: TableColumnsType<AdminTaskItemDto> = [
    { title: '任务', dataIndex: 'id', width: 280, ellipsis: true },
    { title: '会话', dataIndex: 'sessionId', width: 240, ellipsis: true },
    { title: '目标', dataIndex: 'goal', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    { title: '最近运行', dataIndex: 'latestRunStatus', width: 120, render: (v: string | null) => v || '—' },
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
        <Button size="small" onClick={() => void openTask(t.id)}>
          详情
        </Button>
      ),
    },
  ];

  const runColumns: TableColumnsType<AdminTaskDetailDto['runs'][number]> = [
    { title: '运行', dataIndex: 'id', width: 260, ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: '开始',
      dataIndex: 'startedAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
    {
      title: '结束',
      dataIndex: 'endedAt',
      width: 180,
      render: (v: string | null) => (v ? formatTime(v) : '—'),
    },
    { title: '积分', dataIndex: 'credits', align: 'right', width: 90, render: (v: number | null) => v ?? '—' },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_: unknown, r) => (
        <Button size="small" onClick={() => void openRun(r.id)}>
          查看 step
        </Button>
      ),
    },
  ];

  const stepColumns: TableColumnsType<AdminRunDetailDto['steps']['items'][number]> = [
    { title: 'seq', dataIndex: 'seq', width: 70, align: 'right' },
    { title: '类型', dataIndex: 'type', width: 160 },
    {
      title: 'payload',
      dataIndex: 'payload',
      render: (v: unknown) => (
        <Typography.Text code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
          {JSON.stringify(v)}
        </Typography.Text>
      ),
    },
    {
      title: '时间',
      dataIndex: 'ts',
      width: 180,
      render: (v: string) => formatTime(v),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          任务与运行
        </Typography.Title>
        <Typography.Text type="secondary">只读排障：任务、运行、step 与用量。</Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card
        title={
          <Space wrap>
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
              placeholder="会话 ID"
              value={sessionId}
              onChange={(e) => {
                setPage(1);
                setSessionId(e.target.value);
              }}
              style={{ width: 240 }}
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
                { value: 'running', label: '运行中' },
                { value: 'queued', label: '排队中' },
                { value: 'done', label: '完成' },
                { value: 'failed', label: '失败' },
              ]}
            />
          </Space>
        }
        extra={<Typography.Text type="secondary">共 {total} 条</Typography.Text>}
      >
        <Table<AdminTaskItemDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1200 }}
          locale={{ emptyText: '没有匹配的任务' }}
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
        title={detail ? `任务详情 · ${detail.id}` : '任务详情'}
        width={1000}
        open={detail !== null || taskLoading}
        onClose={closeTask}
        destroyOnHidden
        loading={taskLoading}
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="任务目标">
              <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{detail.goal}</Typography.Text>
            </Card>

            <Table<AdminTaskDetailDto['runs'][number]>
              rowKey="id"
              size="small"
              columns={runColumns}
              dataSource={detail.runs}
              scroll={{ x: 900 }}
              pagination={false}
              locale={{ emptyText: '暂无运行' }}
            />

            {run ? (
              <Card
                size="small"
                title={`运行 ${run.id}`}
                extra={
                  <Button
                    size="small"
                    onClick={() => {
                      // 关闭面板时作废在途的运行请求，避免被迟到响应重新打开
                      runSeq.current += 1;
                      setRun(null);
                      setTimeline(null);
                      setTraceCopied(false);
                      setRunLoading(false);
                    }}
                  >
                    关闭运行详情
                  </Button>
                }
                loading={runLoading}
              >
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Descriptions column={3} size="small" bordered>
                    <Descriptions.Item label="状态">{run.status}</Descriptions.Item>
                    <Descriptions.Item label="输入 tokens">
                      {run.usage?.inputTokens ?? 0}
                    </Descriptions.Item>
                    <Descriptions.Item label="输出 tokens">
                      {run.usage?.outputTokens ?? 0}
                    </Descriptions.Item>
                    <Descriptions.Item label="积分">{run.usage?.credits ?? '—'}</Descriptions.Item>
                  </Descriptions>

                  {timeline ? (
                    <Card size="small" title="时间线">
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Typography.Text type="secondary">
                          {timeline.nodes.length} 个节点 · 用时 {formatDuration(timeline.durationMs)} ·
                          tokens {timeline.usage ? timeline.usage.inputTokens : '—'}/
                          {timeline.usage ? timeline.usage.outputTokens : '—'} · 积分{' '}
                          {timeline.usage?.credits ?? '—'}
                        </Typography.Text>
                        <Space size={8}>
                          <Typography.Text type="secondary">
                            trace {timeline.traceId ?? '—'}
                          </Typography.Text>
                          {timeline.traceId ? (
                            <Button
                              size="small"
                              onClick={() => {
                                if (timeline.traceId) void copyTrace(timeline.traceId);
                              }}
                            >
                              {traceCopied ? '已复制' : '复制 traceId'}
                            </Button>
                          ) : null}
                        </Space>
                        <Timeline
                          items={timeline.nodes.map((node) => ({
                            key: node.id,
                            color: TIMELINE_COLOR[timelineStatusTone(node.status)],
                            children: (
                              <div>
                                <Space size={8} wrap>
                                  <Typography.Text strong>{node.label}</Typography.Text>
                                  <Tag>{timelineStatusLabel(node.status)}</Tag>
                                  <Typography.Text type="secondary">
                                    {new Date(node.startedAt).toLocaleTimeString('zh-CN', {
                                      hour12: false,
                                    })}
                                  </Typography.Text>
                                  {node.durationMs !== null ? (
                                    <Typography.Text type="secondary">
                                      {formatDuration(node.durationMs)}
                                    </Typography.Text>
                                  ) : null}
                                </Space>
                                <div>
                                  <Typography.Text type="secondary">
                                    {timelineKindLabel(node.kind)}
                                  </Typography.Text>
                                </div>
                              </div>
                            ),
                          }))}
                        />
                        {timeline.truncated ? (
                          <Typography.Text type="secondary">
                            节点过多，已省略部分节点。
                          </Typography.Text>
                        ) : null}
                      </Space>
                    </Card>
                  ) : null}

                  {runLoading ? (
                    <Typography.Text type="secondary">运行详情加载中…</Typography.Text>
                  ) : (
                    <>
                      <Table<AdminRunDetailDto['steps']['items'][number]>
                        rowKey="id"
                        size="small"
                        columns={stepColumns}
                        dataSource={run.steps.items}
                        scroll={{ x: 760 }}
                        pagination={false}
                        locale={{ emptyText: '暂无 step' }}
                      />
                      <Typography.Text type="secondary">
                        共 {run.steps.total} 条 step
                      </Typography.Text>
                    </>
                  )}
                </Space>
              </Card>
            ) : runLoading ? (
              <Typography.Text type="secondary">运行详情加载中…</Typography.Text>
            ) : null}
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
