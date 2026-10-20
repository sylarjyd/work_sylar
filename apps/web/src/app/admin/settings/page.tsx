'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminSettingDto, AdminSettingValue, SettingSource } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminSettings,
  resetAdminSetting,
  updateAdminSetting,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

const SOURCE_LABEL: Record<SettingSource, string> = {
  db: '数据库',
  env: '环境变量',
  default: '默认值',
};

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

/** 生效值只读展示；secret 永远只显示脱敏串。 */
function displayValue(item: AdminSettingDto): string {
  switch (item.type) {
    case 'number':
      return String(item.value);
    case 'string':
      return item.value === '' ? '（空）' : item.value;
    case 'boolean':
      return item.value ? '启用' : '停用';
    case 'secret':
      return item.configured ? (item.maskedValue ?? '已配置') : '未配置';
  }
}

/** 输入框初值：secret 永不预填，避免浏览器/插件读到明文。 */
function initialDraft(item: AdminSettingDto): string {
  switch (item.type) {
    case 'number':
      return String(item.value);
    case 'string':
      return item.value;
    case 'boolean':
      return String(item.value);
    case 'secret':
      return '';
  }
}

function rangeText(item: AdminSettingDto): string {
  switch (item.type) {
    case 'number':
      return `${item.min}–${item.max}`;
    case 'string':
      return `≤ ${item.maxLength} 字符`;
    default:
      return '—';
  }
}

type Parsed = { value: AdminSettingValue } | { error: string };

function parseDraft(item: AdminSettingDto, raw: string): Parsed {
  if (item.type === 'number') {
    const text = raw.trim();
    // 空串不能被 Number 隐式解析为 0，必须显式拒绝。
    const value = text ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < item.min || value > item.max) {
      return { error: `${item.key} 必须是 ${item.min}–${item.max} 的整数` };
    }
    return { value };
  }
  if (item.type === 'boolean') return { value: raw === 'true' };
  if (item.type === 'string') {
    if (raw.length > item.maxLength) {
      return { error: `${item.key} 不能超过 ${item.maxLength} 个字符` };
    }
    if (item.key === 'alertWebhookUrl' && raw !== '') {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return { error: 'Webhook 地址只支持 http/https' };
        }
      } catch {
        return { error: 'Webhook 地址格式不合法' };
      }
    }
    return { value: raw };
  }
  if (raw.trim() === '') {
    return { error: '请输入新的密钥，或使用“清空密钥”' };
  }
  if (raw.length > item.maxLength) {
    return { error: `${item.key} 不能超过 ${item.maxLength} 个字符` };
  }
  return { value: raw };
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminSettingDto[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  // 记录正在写的参数 key：非 null 时禁用所有输入与按钮，避免并发写互相覆盖
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const inFlight = useRef(false);
  // 有未保存输入的参数 key：刷新时保留其草稿，避免被服务端值静默覆盖。
  const dirtyRef = useRef<Set<string>>(new Set());

  function markDirty(key: string): void {
    dirtyRef.current.add(key);
  }

  function clearDirty(key: string): void {
    dirtyRef.current.delete(key);
  }

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return true;
      }
      if (isForbidden(err)) {
        router.push('/');
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
      const rows = await listAdminSettings();
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setItems(rows);
      // 仅保留有未保存修改的行，其余以服务端值为准。
      setDraft((prev) => {
        const next: Record<string, string> = {};
        for (const r of rows) {
          next[r.key] = dirtyRef.current.has(r.key)
            ? (prev[r.key] ?? initialDraft(r))
            : initialDraft(r);
        }
        return next;
      });
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的闭包覆盖后续状态
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshAfterWrite() {
    // 写操作已成功，先给出明确的成功提示，避免刷新失败被误判为操作失败而重复提交
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  async function save(item: AdminSettingDto) {
    if (inFlight.current) return;
    setError('');
    setNotice('');
    const parsed = parseDraft(item, draft[item.key] ?? '');
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }

    // secret 的新值绝不出现在确认文案里。
    const after = item.type === 'secret' ? '（新密钥，内容隐藏）' : String(parsed.value);
    if (!window.confirm(`确认把 ${item.key} 从 ${displayValue(item)} 改为 ${after}？`)) return;

    inFlight.current = true;
    setBusyKey(item.key);
    try {
      await updateAdminSetting(item.key, parsed.value);
      // 保存成功后才清除 dirty；失败时保留未保存的输入。
      clearDirty(item.key);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  }

  async function reset(item: AdminSettingDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认清除 ${item.key} 的数据库覆盖，恢复环境变量/默认值？`)) return;
    inFlight.current = true;
    setBusyKey(item.key);
    setError('');
    setNotice('');
    try {
      await resetAdminSetting(item.key);
      // 恢复默认成功后清除 dirty；失败时保留未保存的输入。
      clearDirty(item.key);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  }

  async function clearSecret(item: AdminSettingDto) {
    if (inFlight.current) return;
    if (
      !window.confirm(
        `确认清空 ${item.key}？清空会覆盖环境变量中的同名密钥，Webhook 将不再签名。`,
      )
    ) {
      return;
    }
    inFlight.current = true;
    setBusyKey(item.key);
    setError('');
    setNotice('');
    try {
      await updateAdminSetting(item.key, null);
      clearDirty(item.key);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  }

  const busy = busyKey !== null;

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">参数配置</h1>
            <p className="page-sub">
              修改即时生效：运行参数随下一次 run 下发，KB 参数随下一次摄取下发；密钥只显示脱敏值。
            </p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {notice && (
          <div
            className="banner"
            role="status"
            style={{ marginBottom: 16, background: 'var(--surface-2)', border: '1px solid var(--line)' }}
          >
            {notice}
          </div>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">暂无参数</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>参数</th>
                <th>生效值 / 修改</th>
                <th>来源</th>
                <th>范围</th>
                <th>更新人</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td>
                    {item.key}
                    <div className="page-sub" style={{ marginTop: 4, fontSize: 12 }}>
                      {item.type === 'secret' ? '密钥' : item.type}
                    </div>
                  </td>
                  <td>
                    {item.type === 'boolean' ? (
                      <select
                        className="admin-input"
                        style={{ width: 120 }}
                        value={draft[item.key] ?? 'true'}
                        disabled={busy}
                        onChange={(e) => {
                          markDirty(item.key);
                          setDraft({ ...draft, [item.key]: e.target.value });
                        }}
                      >
                        <option value="true">启用</option>
                        <option value="false">停用</option>
                      </select>
                    ) : (
                      <input
                        type={item.type === 'number' ? 'number' : item.type === 'secret' ? 'password' : 'text'}
                        min={item.type === 'number' ? item.min : undefined}
                        max={item.type === 'number' ? item.max : undefined}
                        step={item.type === 'number' ? 1 : undefined}
                        className="admin-input"
                        style={{ width: item.type === 'string' ? 280 : 180 }}
                        placeholder={
                          item.type === 'secret'
                            ? item.configured
                              ? `已配置（${item.maskedValue}），留空不修改`
                              : '未配置'
                            : undefined
                        }
                        value={draft[item.key] ?? ''}
                        disabled={busy}
                        onChange={(e) => {
                          markDirty(item.key);
                          setDraft({ ...draft, [item.key]: e.target.value });
                        }}
                      />
                    )}
                    <div className="page-sub" style={{ marginTop: 4, fontSize: 12 }}>
                      当前：{displayValue(item)}
                    </div>
                  </td>
                  <td>{SOURCE_LABEL[item.source] ?? item.source}</td>
                  <td>{rangeText(item)}</td>
                  <td>{item.updatedBy || '—'}</td>
                  <td>{formatTime(item.updatedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn primary"
                      disabled={busy}
                      onClick={() => void save(item)}
                    >
                      保存
                    </button>{' '}
                    {item.type === 'secret' && item.configured && (
                      <>
                        <button
                          type="button"
                          className="admin-btn"
                          disabled={busy}
                          onClick={() => void clearSecret(item)}
                        >
                          清空密钥
                        </button>{' '}
                      </>
                    )}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy || item.source !== 'db'}
                      onClick={() => void reset(item)}
                    >
                      恢复默认
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
