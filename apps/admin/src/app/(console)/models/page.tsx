'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminModelPriceDto, AdminModelProviderDto } from '@ai-office/shared';
import {
  adminErrorText,
  createModelPrice,
  deleteModelPrice,
  getAdminModels,
  isForbidden,
  updateModelPrice,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

/** 与数据库 int 上限保持一致，避免提交后才由服务端报错。 */
const MAX_MILLI_CREDITS = 2_147_483_647;

function parseAmount(raw: string): number | null {
  const text = raw.trim();
  // 空串不能被 Number 隐式解析为 0，必须显式拒绝。
  if (!text) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MILLI_CREDITS) return null;
  return value;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function AdminModelsPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<AdminModelProviderDto[]>([]);
  const [prices, setPrices] = useState<AdminModelPriceDto[]>([]);
  const [model, setModel] = useState('');
  const [input, setInput] = useState('0');
  const [output, setOutput] = useState('0');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
  const inFlight = useRef(false);

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

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await getAdminModels();
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setProviders(data.providers);
      setPrices(data.prices);
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

  function resetForm() {
    setModel('');
    setInput('0');
    setOutput('0');
  }

  async function refreshAfterWrite() {
    // 写操作已成功，先给出明确的成功提示，避免刷新失败被误判为操作失败而重复提交
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  function startEdit(price: AdminModelPriceDto) {
    setError('');
    setNotice('');
    setModel(price.model);
    setInput(String(price.inputMilliCreditsPer1k));
    setOutput(String(price.outputMilliCreditsPer1k));
  }

  async function save() {
    if (inFlight.current) return;
    setError('');
    setNotice('');
    const name = model.trim();
    if (!name) {
      setError('模型名不能为空');
      return;
    }
    const inputValue = parseAmount(input);
    const outputValue = parseAmount(output);
    if (inputValue === null || outputValue === null) {
      setError('输入/输出必须是非负整数');
      return;
    }
    const exists = prices.some((p) => p.model === name);
    if (!window.confirm(`确认${exists ? '更新' : '新增'}模型价格 ${name}？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (exists) {
        await updateModelPrice(name, {
          inputMilliCreditsPer1k: inputValue,
          outputMilliCreditsPer1k: outputValue,
        });
      } else {
        await createModelPrice({
          model: name,
          inputMilliCreditsPer1k: inputValue,
          outputMilliCreditsPer1k: outputValue,
        });
      }
      resetForm();
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (inFlight.current) return;
    if (!window.confirm(`确认删除模型价格 ${name}？被启用套餐引用时会被拒绝。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteModelPrice(name);
      // 避免表单残留已删除的模型，后续保存时把它重新创建出来
      if (model.trim() === name) resetForm();
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">模型配置</h1>
            <p className="page-sub">查看已配置 provider 的模型；维护每千 token 的毫积分费率。</p>
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

        <section className="admin-panel">
          <h2 className="billing-heading">当前 provider</h2>
          {providers.length === 0 ? (
            <p className="admin-muted">未解析到 provider</p>
          ) : (
            <ul className="billing-list">
              {providers.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong>：{p.models.join('、')}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="admin-panel">
          <h2 className="billing-heading">新增 / 更新价格</h2>
          <div className="admin-form">
            <label className="admin-field">
              模型名
              <input
                className="admin-input"
                value={model}
                disabled={busy}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <label className="admin-field">
              输入（毫积分/1K）
              <input
                className="admin-input"
                type="number"
                min={0}
                max={MAX_MILLI_CREDITS}
                step={1}
                value={input}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
            <label className="admin-field">
              输出（毫积分/1K）
              <input
                className="admin-input"
                type="number"
                min={0}
                max={MAX_MILLI_CREDITS}
                step={1}
                value={output}
                disabled={busy}
                onChange={(e) => setOutput(e.target.value)}
              />
            </label>
            <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : prices.length === 0 ? (
          <div className="admin-empty">暂无模型价格</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>输入</th>
                <th>输出</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.model}>
                  <td>{p.model}</td>
                  <td className="numeric">{p.inputMilliCreditsPer1k}</td>
                  <td className="numeric">{p.outputMilliCreditsPer1k}</td>
                  <td>{formatTime(p.updatedAt)}</td>
                  <td>
                    <button type="button" className="admin-btn" disabled={busy} onClick={() => startEdit(p)}>
                      编辑
                    </button>{' '}
                    <button type="button" className="admin-btn" disabled={busy} onClick={() => void remove(p.model)}>
                      删除
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
