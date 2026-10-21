'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
        pageSize: 20,
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

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">告警中心</h1>
            <p className="page-sub">调整规则阈值、查看触发记录并验证 Webhook 投递。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <section className="admin-panel">
          <h2 className="billing-heading">告警规则</h2>
          {rulesLoading ? (
            <div className="admin-empty">加载中…</div>
          ) : rules.length === 0 ? (
            <div className="admin-empty">暂无规则</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>规则</th>
                  <th>条件</th>
                  <th>阈值</th>
                  <th>窗口(分)</th>
                  <th>冷却(分)</th>
                  <th>级别</th>
                  <th>启用</th>
                  <th>测试结果</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const draft = drafts[rule.id] ?? toDraft(rule);
                  return (
                    <tr key={rule.id}>
                      <td>
                        <div>{rule.name}</div>
                        <div className="admin-muted">{rule.key}</div>
                      </td>
                      <td className="admin-muted">
                        {rule.metric} {rule.comparator === 'gt' ? '>' : '<'}
                      </td>
                      <td>
                        <input
                          className="admin-input alert-cell-input"
                          type="number"
                          step="any"
                          value={draft.threshold}
                          aria-label={`${rule.name} 阈值`}
                          onChange={(event) =>
                            updateDraft(rule.id, { threshold: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="admin-input alert-cell-input"
                          type="number"
                          min={1}
                          max={1440}
                          step={1}
                          value={draft.windowMinutes}
                          aria-label={`${rule.name} 统计窗口`}
                          onChange={(event) =>
                            updateDraft(rule.id, { windowMinutes: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="admin-input alert-cell-input"
                          type="number"
                          min={0}
                          max={1440}
                          step={1}
                          value={draft.cooldownMinutes}
                          aria-label={`${rule.name} 冷却时间`}
                          onChange={(event) =>
                            updateDraft(rule.id, { cooldownMinutes: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          className="admin-input"
                          value={draft.severity}
                          aria-label={`${rule.name} 级别`}
                          onChange={(event) =>
                            updateDraft(rule.id, {
                              severity: event.target.value as 'warning' | 'critical',
                            })
                          }
                        >
                          <option value="warning">警告</option>
                          <option value="critical">严重</option>
                        </select>
                      </td>
                      <td>
                        <label className="alert-enabled">
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            aria-label={`${rule.name} 启用`}
                            onChange={(event) =>
                              updateDraft(rule.id, { enabled: event.target.checked })
                            }
                          />
                          {draft.enabled ? '启用' : '停用'}
                        </label>
                      </td>
                      <td className="admin-muted">{testResults[rule.id] ?? '—'}</td>
                      <td>
                        <div className="alert-actions">
                          <button
                            type="button"
                            className="admin-btn primary"
                            disabled={savingId !== ''}
                            onClick={() => void saveRule(rule)}
                          >
                            {savingId === rule.id ? '保存中…' : '保存'}
                          </button>
                          <button
                            type="button"
                            className="admin-btn"
                            disabled={testingId !== ''}
                            onClick={() => void testRule(rule)}
                          >
                            {testingId === rule.id ? '发送中…' : '发送测试'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="admin-muted" style={{ marginTop: 8 }}>
            停用规则会同时关闭其未恢复事件；测试告警与真实告警共用每小时配额。
          </p>
        </section>

        <section className="admin-panel">
          <div className="admin-toolbar" style={{ marginBottom: 12 }}>
            <h2 className="billing-heading" style={{ margin: 0 }}>
              告警事件
            </h2>
            <select
              className="admin-input"
              value={eventStatus}
              aria-label="事件状态"
              onChange={(event) => {
                setEventPage(1);
                setEventStatus(event.target.value as '' | 'firing' | 'resolved');
              }}
            >
              <option value="">全部状态</option>
              <option value="firing">触发中</option>
              <option value="resolved">已恢复</option>
            </select>
            <span className="admin-muted">共 {eventsTotal} 条</span>
          </div>

          {eventsLoading ? (
            <div className="admin-empty">加载中…</div>
          ) : events.length === 0 ? (
            <div className="admin-empty">暂无事件</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>规则</th>
                  <th>值</th>
                  <th>消息</th>
                  <th>开始</th>
                  <th>恢复</th>
                  <th>投递</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <span className={`alert-badge ${event.status}`}>
                        {event.status === 'firing' ? '触发中' : '已恢复'}
                      </span>
                    </td>
                    <td>{event.ruleName}</td>
                    <td className="numeric">{event.value}</td>
                    <td>{event.message}</td>
                    <td>{new Date(event.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>
                      {event.resolvedAt
                        ? new Date(event.resolvedAt).toLocaleString('zh-CN', { hour12: false })
                        : '—'}
                    </td>
                    <td className="admin-muted">
                      {alertDeliveryText(event.deliveryStatus, event.deliveryError)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="admin-pager">
            <button
              type="button"
              className="admin-btn"
              disabled={eventPage <= 1 || eventsLoading}
              onClick={() => setEventPage((page) => Math.max(1, page - 1))}
            >
              上一页
            </button>
            <span>第 {eventPage} 页</span>
            <button
              type="button"
              className="admin-btn"
              disabled={eventPage * 20 >= eventsTotal || eventsLoading}
              onClick={() => setEventPage((page) => page + 1)}
            >
              下一页
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
