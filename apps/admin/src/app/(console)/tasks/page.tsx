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
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  RetryRunResultDto,
  RunStatus,
} from '@ai-office/shared';
import {
  adminCancelRun,
  adminErrorText,
  adminRetryRun,
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
import {
  canCancelRun,
  canRetryRun,
  TASK_STATUS_META,
} from '../../../lib/task-status';

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

function taskStatusTag(value: RunStatus | null) {
  if (!value) return '—';
  const meta = TASK_STATUS_META[value];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export default function AdminTasksPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
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
  // 写操作成功但刷新失败时必须明确提示，否则运营会以为页面状态就是最新的而重复提交。
  const [notice, setNotice] = useState('');
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
  // 记录当前打开的任务，写操作后只有它还开着才回写详情，避免用户关闭面板后又被重新打开。
  const detailIdRef = useRef<string | null>(null);
  // 防重提交：确认框之后、首个 await 之前占位，finally 复位。
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  // 返回是否拿到最新数据：写操作后的刷新要据此决定是否提示「刷新失败」。
  async function openTask(id: string): Promise<boolean> {
    const seq = ++taskSeq.current;
    detailIdRef.current = id;
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
      // 过期请求不算失败，避免把「用户已切走」误报成刷新失败。
      if (seq !== taskSeq.current) return true;
      setDetail(data);
      return true;
    } catch (err) {
      if (seq !== taskSeq.current) return true;
      handleErr(err);
      return false;
    } finally {
      if (seq === taskSeq.current) setTaskLoading(false);
    }
  }

  function closeTask() {
    // 递增序号让在途的任务/运行请求失效
    taskSeq.current++;
    runSeq.current++;
    detailIdRef.current = null;
    setDetail(null);
    setRun(null);
    setTimeline(null);
    setTraceCopied(false);
    setTaskLoading(false);
    setRunLoading(false);
  }

  async function openRun(id: string): Promise<boolean> {
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
      if (seq !== runSeq.current) return true;
      if (runResult.status === 'rejected') {
        handleErr(runResult.reason);
        return false;
      }
      setRun(runResult.value);
      if (timelineResult.status === 'fulfilled') {
        setTimeline(timelineResult.value);
      } else {
        // 时间线失败不影响运行详情是否新鲜；错误已单独展示。
        handleErr(timelineResult.reason);
      }
      return true;
    } catch (err) {
      if (seq !== runSeq.current) return true;
      handleErr(err);
      return false;
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

  // 写操作改变的是任务/运行状态，列表与已打开的详情都要重载；任务已被切走时不再回写。
  async function refreshAfterAction(taskId: string | null): Promise<boolean> {
    const listOk = await load();
    if (taskId && detailIdRef.current === taskId) {
      const detailOk = await openTask(taskId);
      return listOk && detailOk;
    }
    return listOk;
  }

  /**
   * 取消/重试共用的提交壳：防重、鉴权跳转、失败也刷新、刷新失败提示。
   * refresh 在写操作之后执行，用来回写列表与当前打开的任务/运行。
   */
  async function runAction(
    action: () => Promise<void>,
    refresh: (taskId: string | null) => Promise<boolean>,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const taskId = detailIdRef.current;
    try {
      let failed: unknown = null;
      try {
        await action();
      } catch (err) {
        failed = err;
      }
      if (failed && (isUnauthorized(failed) || isForbidden(failed))) {
        handleErr(failed);
        return;
      }
      // 即便失败也刷新：409 等冲突通常意味着页面状态已过期，需要让运营看到真实状态。
      const refreshed = await refresh(taskId);
      // 写操作的错误必须最后展示：刷新流程内部会清空 error。
      if (failed) handleErr(failed);
      if (!refreshed) {
        setNotice(
          failed
            ? '操作失败，且数据刷新失败；请手动刷新页面确认当前状态。'
            : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。',
        );
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function askCancelRun(r: AdminTaskDetailDto['runs'][number]) {
    modal.confirm({
      title: '取消该运行？',
      content: (
        <div>
          <div>运行 {r.id}</div>
          <div style={{ color: '#8a958f' }}>
            第 {r.attempt} 次 · {TASK_STATUS_META[r.status].label}
          </div>
          <div style={{ color: '#8a958f' }}>
            排队中的运行会立即取消；运行中的运行会请求停止，已产生的 step 与用量仍会保留。
          </div>
        </div>
      ),
      okText: '确认取消',
      okType: 'danger',
      cancelText: '返回',
      onOk: () =>
        runAction(
          async () => {
            await adminCancelRun(r.id);
            message.success('取消已受理');
          },
          async (taskId) => {
            const refreshed = await refreshAfterAction(taskId);
            // 已打开的运行详情状态/用量已变，需要重新拉取，避免停留在旧状态。
            const reopenRunId = run?.id ?? null;
            if (reopenRunId && detailIdRef.current === taskId) {
              const runOk = await openRun(reopenRunId);
              return refreshed && runOk;
            }
            return refreshed;
          },
        ),
    });
  }

  function askRetryRun(r: AdminTaskDetailDto['runs'][number]) {
    let retried: RetryRunResultDto | null = null;
    modal.confirm({
      title: '重试该运行？',
      content: (
        <div>
          <div>运行 {r.id}</div>
          <div style={{ color: '#8a958f' }}>
            第 {r.attempt} 次 · {TASK_STATUS_META[r.status].label}
          </div>
          <div style={{ color: '#8a958f' }}>将基于任务目标创建一次新运行并重新排队。</div>
        </div>
      ),
      okText: '确认重试',
      cancelText: '返回',
      onOk: () =>
        runAction(
          async () => {
            retried = await adminRetryRun(r.id);
            message.success(`已重试，新运行 attempt ${retried.attempt} 已排队`);
          },
          async (taskId) => {
            const refreshed = await refreshAfterAction(taskId);
            // 成功后直接打开新运行，运营可继续查看排队/执行进度；失败则保持原运行卡片。
            const nextRunId = retried?.runId ?? run?.id ?? null;
            if (nextRunId && detailIdRef.current === taskId) {
              const runOk = await openRun(nextRunId);
              return refreshed && runOk;
            }
            return refreshed;
          },
        ),
    });
  }

  const columns: TableColumnsType<AdminTaskItemDto> = [
    { title: '任务', dataIndex: 'id', width: 280, ellipsis: true },
    { title: '会话', dataIndex: 'sessionId', width: 240, ellipsis: true },
    { title: '目标', dataIndex: 'goal', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: RunStatus) => taskStatusTag(v),
    },
    {
      title: '最近运行',
      dataIndex: 'latestRunStatus',
      width: 120,
      render: (v: RunStatus | null) => taskStatusTag(v),
    },
    { title: '尝试次数', dataIndex: 'attempts', width: 90, align: 'right' },
    {
      title: '排队时间',
      dataIndex: 'queuedAt',
      width: 180,
      render: (v: string) => (v ? formatTime(v) : '—'),
    },
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
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: RunStatus) => taskStatusTag(v),
    },
    {
      title: '开始',
      dataIndex: 'startedAt',
      width: 180,
      render: (v: string | null) => (v ? formatTime(v) : '—'),
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
      width: 230,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button size="small" onClick={() => void openRun(r.id)}>
            查看 step
          </Button>
          {canCancelRun(r.status) ? (
            <Button size="small" danger disabled={busy} onClick={() => askCancelRun(r)}>
              取消
            </Button>
          ) : null}
          {canRetryRun(r.status) ? (
            <Button size="small" disabled={busy} onClick={() => askRetryRun(r)}>
              重试
            </Button>
          ) : null}
        </Space>
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
        <Typography.Text type="secondary">
          任务运行排障：查看任务、运行、step 与用量，并可取消或重试运行。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}

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
                { value: 'canceled', label: '已取消' },
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
          scroll={{ x: 1400 }}
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
              scroll={{ x: 1100 }}
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
                    <Descriptions.Item label="状态">
                      {taskStatusTag(run.status)}
                    </Descriptions.Item>
                    <Descriptions.Item label="尝试">第 {run.attempt} 次</Descriptions.Item>
                    <Descriptions.Item label="积分">{run.usage?.credits ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="输入 tokens">
                      {run.usage?.inputTokens ?? 0}
                    </Descriptions.Item>
                    <Descriptions.Item label="输出 tokens">
                      {run.usage?.outputTokens ?? 0}
                    </Descriptions.Item>
                    <Descriptions.Item label="断点续跑" span={3}>
                      {run.checkpoint
                        ? `第 ${run.checkpoint.round} 轮 · seq ${run.checkpoint.seq} · ${formatTime(
                            run.checkpoint.updatedAt,
                          )}`
                        : '—'}
                    </Descriptions.Item>
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
