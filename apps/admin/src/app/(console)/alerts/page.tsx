'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminAlertEventDto, AdminAlertRuleDto } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminAlertEvents,
  listAdminAlertRules,
  sendAdminAlertTest,
  updateAdminAlertRule,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';
import {
  alertDeliveryText,
  parseAlertDraft,
  toDraft,
  type AlertRuleDraft,
} from '../../../lib/alert-draft';

const PAGE_SIZE = 20;

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function numberText(v: number | null): string {
  return v === null ? '' : String(v);
}

export default function AdminAlertsPage() {
  const router = useRouter();
  const [rules, setRules] = useState<AdminAlertRuleDto[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AlertRuleDraft>>({});
  const [events, setEvents] = useState<AdminAlertEventDto[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventPage, setEventPage] = useState(1);
  const [eventStatus, setEventStatus] = useState<'' | 'firing' | 'resolved'>('');
  const [rulesLoading, setRulesLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [testingId, setTestingId] = useState('');
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const handleErr = useCallback(
    (err: unknown) => {
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

  const rulesSeq = useRef(0);
  const loadRules = useCallback(async () => {
    const id = ++rulesSeq.current;
    setRulesLoading(true);
    try {
      const data = await listAdminAlertRules();
      if (id !== rulesSeq.current) return;
      setRules(data);
      setDrafts(Object.fromEntries(data.map((rule) => [rule.id, toDraft(rule)] as const)));
    } catch (err) {
      if (id === rulesSeq.current) handleErr(err);
    } finally {
      if (id === rulesSeq.current) setRulesLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const eventsSeq = useRef(0);
  const loadEvents = useCallback(async () => {
    const id = ++eventsSeq.current;
    setEventsLoading(true);
    try {
      const data = await listAdminAlertEvents({
        status: eventStatus || undefined,
        page: eventPage,
        pageSize: PAGE_SIZE,
      });
      if (id !== eventsSeq.current) return;
      setEvents(data.items);
      setEventsTotal(data.total);
    } catch (err) {
      if (id === eventsSeq.current) handleErr(err);
    } finally {
      if (id === eventsSeq.current) setEventsLoading(false);
    }
  }, [eventStatus, eventPage, handleErr]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  function updateDraft(id: string, patch: Partial<AlertRuleDraft>) {
    setDrafts((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }

  async function saveRule(rule: AdminAlertRuleDto) {
    const draft = drafts[rule.id];
    if (!draft) return;
    const parsed = parseAlertDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSavingId(rule.id);
    setError('');
    try {
      const updated = await updateAdminAlertRule(rule.id, parsed.patch);
      setRules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setDrafts((prev) => ({ ...prev, [updated.id]: toDraft(updated) }));
    } catch (err) {
      handleErr(err);
    } finally {
      setSavingId('');
    }
  }

  async function testRule(rule: AdminAlertRuleDto) {
    setTestingId(rule.id);
    setError('');
    try {
      const result = await sendAdminAlertTest(rule.id);
      setTestResults((prev) => ({
        ...prev,
        [rule.id]: alertDeliveryText(result.deliveryStatus, result.deliveryError),
      }));
    } catch (err) {
      handleErr(err);
    } finally {
      setTestingId('');
    }
  }

  const ruleColumns: TableColumnsType<AdminAlertRuleDto> = [
    {
      title: '规则',
      dataIndex: 'name',
      render: (_: unknown, rule) => (
        <div>
          <Typography.Text strong>{rule.name}</Typography.Text>
          <div style={{ fontSize: 12, color: '#8a958f' }}>{rule.key}</div>
        </div>
      ),
    },
    {
      title: '条件',
      key: 'condition',
      width: 200,
      render: (_: unknown, rule) => (
        <Typography.Text type="secondary">
          {rule.metric} {rule.comparator === 'gt' ? '>' : '<'}
        </Typography.Text>
      ),
    },
    {
      title: '阈值',
      key: 'threshold',
      width: 130,
      render: (_: unknown, rule) => {
        const draft = drafts[rule.id] ?? toDraft(rule);
        return (
          <InputNumber
            style={{ width: '100%' }}
            step={0.1}
            value={draft.threshold.trim() === '' ? null : Number(draft.threshold)}
            aria-label={`${rule.name} 阈值`}
            onChange={(v) => updateDraft(rule.id, { threshold: numberText(v) })}
          />
        );
      },
    },
    {
      title: '窗口(分)',
      key: 'windowMinutes',
      width: 120,
      render: (_: unknown, rule) => {
        const draft = drafts[rule.id] ?? toDraft(rule);
        return (
          <InputNumber
            style={{ width: '100%' }}
            min={1}
            max={1440}
            precision={0}
            value={draft.windowMinutes.trim() === '' ? null : Number(draft.windowMinutes)}
            aria-label={`${rule.name} 统计窗口`}
            onChange={(v) => updateDraft(rule.id, { windowMinutes: numberText(v) })}
          />
        );
      },
    },
    {
      title: '冷却(分)',
      key: 'cooldownMinutes',
      width: 120,
      render: (_: unknown, rule) => {
        const draft = drafts[rule.id] ?? toDraft(rule);
        return (
          <InputNumber
            style={{ width: '100%' }}
            min={0}
            max={1440}
            precision={0}
            value={draft.cooldownMinutes.trim() === '' ? null : Number(draft.cooldownMinutes)}
            aria-label={`${rule.name} 冷却时间`}
            onChange={(v) => updateDraft(rule.id, { cooldownMinutes: numberText(v) })}
          />
        );
      },
    },
    {
      title: '级别',
      key: 'severity',
      width: 110,
      render: (_: unknown, rule) => {
        const draft = drafts[rule.id] ?? toDraft(rule);
        return (
          <Select
            style={{ width: '100%' }}
            value={draft.severity}
            aria-label={`${rule.name} 级别`}
            onChange={(value: 'warning' | 'critical') =>
              updateDraft(rule.id, { severity: value })
            }
            options={[
              { value: 'warning', label: '警告' },
              { value: 'critical', label: '严重' },
            ]}
          />
        );
      },
    },
    {
      title: '启用',
      key: 'enabled',
      width: 110,
      render: (_: unknown, rule) => {
        const draft = drafts[rule.id] ?? toDraft(rule);
        return (
          <Space size={6}>
            <Switch
              size="small"
              checked={draft.enabled}
              aria-label={`${rule.name} 启用`}
              onChange={(checked) => updateDraft(rule.id, { enabled: checked })}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {draft.enabled ? '启用' : '停用'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '测试结果',
      key: 'test',
      width: 180,
      render: (_: unknown, rule) => (
        <Typography.Text type="secondary">{testResults[rule.id] ?? '—'}</Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_: unknown, rule) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            disabled={savingId !== ''}
            onClick={() => void saveRule(rule)}
          >
            {savingId === rule.id ? '保存中…' : '保存'}
          </Button>
          <Button
            size="small"
            disabled={testingId !== ''}
            onClick={() => void testRule(rule)}
          >
            {testingId === rule.id ? '发送中…' : '发送测试'}
          </Button>
        </Space>
      ),
    },
  ];

  const eventColumns: TableColumnsType<AdminAlertEventDto> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: AdminAlertEventDto['status']) =>
        v === 'firing' ? <Tag color="error">触发中</Tag> : <Tag color="success">已恢复</Tag>,
    },
    { title: '规则', dataIndex: 'ruleName', width: 160 },
    { title: '值', dataIndex: 'value', align: 'right', width: 100 },
    { title: '消息', dataIndex: 'message', ellipsis: true },
    {
      title: '开始',
      dataIndex: 'startedAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
    {
      title: '恢复',
      dataIndex: 'resolvedAt',
      width: 180,
      render: (v: string | null) => (v ? formatTime(v) : '—'),
    },
    {
      title: '投递',
      key: 'delivery',
      width: 220,
      render: (_: unknown, event) => (
        <Typography.Text type="secondary">
          {alertDeliveryText(event.deliveryStatus, event.deliveryError)}
        </Typography.Text>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          告警中心
        </Typography.Title>
        <Typography.Text type="secondary">
          调整规则阈值、查看触发记录并验证 Webhook 投递。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card title="告警规则">
        <Table<AdminAlertRuleDto>
          rowKey="id"
          size="middle"
          loading={rulesLoading}
          columns={ruleColumns}
          dataSource={rules}
          scroll={{ x: 1200 }}
          pagination={false}
          locale={{ emptyText: '暂无规则' }}
        />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          停用规则会同时关闭其未恢复事件；测试告警与真实告警共用每小时配额。
        </Typography.Text>
      </Card>

      <Card
        title="告警事件"
        extra={
          <Space>
            <Select
              value={eventStatus}
              aria-label="事件状态"
              style={{ width: 140 }}
              onChange={(value) => {
                setEventPage(1);
                setEventStatus(value);
              }}
              options={[
                { value: '', label: '全部状态' },
                { value: 'firing', label: '触发中' },
                { value: 'resolved', label: '已恢复' },
              ]}
            />
            <Typography.Text type="secondary">共 {eventsTotal} 条</Typography.Text>
          </Space>
        }
      >
        <Table<AdminAlertEventDto>
          rowKey="id"
          size="middle"
          loading={eventsLoading}
          columns={eventColumns}
          dataSource={events}
          scroll={{ x: 1000 }}
          locale={{ emptyText: '暂无事件' }}
          pagination={{
            current: eventPage,
            pageSize: PAGE_SIZE,
            total: eventsTotal,
            showSizeChanger: false,
            onChange: setEventPage,
          }}
        />
      </Card>
    </Space>
  );
}
