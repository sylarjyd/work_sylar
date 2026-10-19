'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminSettingDto, SettingSource } from '@ai-office/shared';
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
      setDraft(Object.fromEntries(rows.map((r) => [r.key, String(r.value)])));
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
    const text = (draft[item.key] ?? '').trim();
    // 空串不能被 Number 隐式解析为 0，必须显式拒绝。
    const value = text ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < item.min || value > item.max) {
      setError(`${item.key} 必须是 ${item.min}–${item.max} 的整数`);
      return;
    }
    if (!window.confirm(`确认把 ${item.key} 从 ${item.value} 改为 ${value}？`)) return;
    inFlight.current = true;
    setBusyKey(item.key);
    try {
      await updateAdminSetting(item.key, value);
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
            <p className="page-sub">修改即时生效：运行参数随下一次 run 下发，KB 参数随下一次摄取下发。</p>
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
                <th>生效值</th>
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
                  <td>{item.key}</td>
                  <td>
                    <input
                      className="admin-input"
                      style={{ width: 120 }}
                      value={draft[item.key] ?? ''}
                      disabled={busy}
                      onChange={(e) => setDraft({ ...draft, [item.key]: e.target.value })}
                    />
                  </td>
                  <td>{SOURCE_LABEL[item.source] ?? item.source}</td>
                  <td>{`${item.min}–${item.max}`}</td>
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
