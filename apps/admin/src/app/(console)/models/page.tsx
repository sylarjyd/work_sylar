'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminModelDto,
  AdminModelsDto,
  AdminModelTestResultDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  createAdminModel,
  createModelProvider,
  deleteAdminModel,
  deleteModelProvider,
  getAdminModels,
  isForbidden,
  setDefaultModel,
  testAdminModel,
  updateAdminModel,
  updateModelProvider,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

/** 与数据库 int 上限保持一致，避免提交后才由服务端报错。 */
const MAX_MILLI_CREDITS = 2_147_483_647;

function parseAmount(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MILLI_CREDITS) return null;
  return value;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

interface ProviderForm {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface ModelForm {
  editing: boolean;
  model: string;
  displayName: string;
  providerId: string;
  enabled: boolean;
  sortOrder: string;
  input: string;
  output: string;
}

function emptyModelForm(providerId = ''): ModelForm {
  return {
    editing: false,
    model: '',
    displayName: '',
    providerId,
    enabled: false,
    sortOrder: '0',
    input: '0',
    output: '0',
  };
}

export default function AdminModelsPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminModelsDto | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AdminModelTestResultDto>>({});
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
      const next = await getAdminModels();
      if (id !== loadSeq.current) return true;
      setData(next);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshAfterWrite() {
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  async function saveProvider() {
    if (!providerForm || inFlight.current) return;
    setError('');
    setNotice('');
    if (!providerForm.name.trim() || !providerForm.baseUrl.trim()) {
      setError('厂商名称和 Base URL 不能为空');
      return;
    }
    if (!providerForm.id && !providerForm.apiKey.trim()) {
      setError('新增厂商必须填写 API Key');
      return;
    }
    if (!window.confirm(`确认${providerForm.id ? '更新' : '新增'}厂商 ${providerForm.name.trim()}？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (providerForm.id) {
        await updateModelProvider(providerForm.id, {
          name: providerForm.name.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          ...(providerForm.apiKey.trim() ? { apiKey: providerForm.apiKey.trim() } : {}),
        });
      } else {
        await createModelProvider({
          name: providerForm.name.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          apiKey: providerForm.apiKey.trim(),
        });
      }
      setProviderForm(null);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function removeProvider(id: string, name: string) {
    if (inFlight.current) return;
    if (!window.confirm(`确认删除厂商 ${name}？厂商下仍有模型时会被拒绝。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteModelProvider(id);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function saveModel() {
    if (!modelForm || inFlight.current) return;
    setError('');
    setNotice('');
    const name = modelForm.model.trim();
    if (!name) {
      setError('模型名不能为空');
      return;
    }
    if (!modelForm.providerId) {
      setError('必须选择厂商');
      return;
    }
    const input = parseAmount(modelForm.input);
    const output = parseAmount(modelForm.output);
    const order = Number(modelForm.sortOrder);
    if (input === null || output === null) {
      setError('输入/输出必须是非负整数');
      return;
    }
    if (!Number.isSafeInteger(order) || order < 0 || order > 1_000_000) {
      setError('排序必须是非负整数');
      return;
    }
    if (!window.confirm(`确认${modelForm.editing ? '更新' : '新增'}模型 ${name}？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const prices = { inputMilliCreditsPer1k: input, outputMilliCreditsPer1k: output };
      const displayName = modelForm.displayName.trim() || null;
      if (modelForm.editing) {
        await updateAdminModel({
          model: name,
          displayName,
          providerId: modelForm.providerId,
          enabled: modelForm.enabled,
          sortOrder: order,
          prices,
        });
      } else {
        await createAdminModel({
          model: name,
          ...(displayName ? { displayName } : {}),
          providerId: modelForm.providerId,
          enabled: modelForm.enabled,
          sortOrder: order,
          prices,
        });
      }
      setModelForm(null);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function toggleModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await updateAdminModel({ model: row.model, enabled: !row.enabled });
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function makeDefault(row: AdminModelDto) {
    if (inFlight.current || row.isDefault) return;
    if (!window.confirm(`确认将 ${row.model} 设为全局默认模型？`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await setDefaultModel(row.model);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function removeModel(row: AdminModelDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认删除模型 ${row.model}？被默认模型、套餐或有效订阅引用时会被拒绝。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteAdminModel(row.model);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[row.model];
        return next;
      });
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function testModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await testAdminModel(row.model);
      setTestResults((prev) => ({ ...prev, [row.model]: result }));
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const providers = data?.providers ?? [];
  const models = data?.models ?? [];

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">模型配置</h1>
            <p className="page-sub">
              维护厂商与模型目录、启用状态、排序和价格；启用且在当前套餐内的模型会展示给客户端。
            </p>
          </div>
          <div className="admin-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="admin-btn primary"
              disabled={busy}
              onClick={() =>
                setProviderForm({ name: '', baseUrl: '', apiKey: '' })
              }
            >
              新增厂商
            </button>
            <button
              type="button"
              className="admin-btn"
              disabled={busy || providers.length === 0}
              onClick={() => setModelForm(emptyModelForm(providers[0]?.id ?? ''))}
            >
              新增模型
            </button>
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

        {data?.fallback.active && (
          <div className="banner" style={{ marginBottom: 16, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            当前没有在运营平台配置厂商，客户端使用环境变量兜底：
            {data.fallback.providers.map((p) => `${p.name}（${p.models.join('、')}）`).join('；') || '无'}
          </div>
        )}

        {providerForm && (
          <section className="admin-panel">
            <h2 className="billing-heading">{providerForm.id ? '编辑厂商' : '新增厂商'}</h2>
            <div className="admin-form">
              <label className="admin-field">
                厂商名称
                <input
                  className="admin-input"
                  value={providerForm.name}
                  disabled={busy}
                  placeholder="如：豆包、千问、DeepSeek"
                  onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                />
              </label>
              <label className="admin-field">
                Base URL
                <input
                  className="admin-input"
                  value={providerForm.baseUrl}
                  disabled={busy}
                  placeholder="https://ark.cn-beijing.volces.com/api/v3"
                  onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                />
              </label>
              <label className="admin-field">
                API Key{providerForm.id ? '（留空表示不修改）' : ''}
                <input
                  className="admin-input"
                  type="password"
                  autoComplete="new-password"
                  value={providerForm.apiKey}
                  disabled={busy}
                  onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                />
              </label>
              <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void saveProvider()}>
                保存
              </button>
              <button type="button" className="admin-btn" disabled={busy} onClick={() => setProviderForm(null)}>
                取消
              </button>
            </div>
          </section>
        )}

        {modelForm && (
          <section className="admin-panel">
            <h2 className="billing-heading">{modelForm.editing ? '编辑模型' : '新增模型'}</h2>
            <div className="admin-form">
              <label className="admin-field">
                模型名
                <input
                  className="admin-input"
                  value={modelForm.model}
                  disabled={busy || modelForm.editing}
                  placeholder="如：doubao-pro-32k"
                  onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })}
                />
              </label>
              <label className="admin-field">
                展示名称
                <input
                  className="admin-input"
                  value={modelForm.displayName}
                  disabled={busy}
                  placeholder="如：豆包 Pro 32K"
                  onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })}
                />
              </label>
              <label className="admin-field">
                厂商
                <select
                  className="admin-input"
                  value={modelForm.providerId}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, providerId: e.target.value })}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                排序
                <input
                  className="admin-input"
                  type="number"
                  min={0}
                  max={1_000_000}
                  step={1}
                  value={modelForm.sortOrder}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, sortOrder: e.target.value })}
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
                  value={modelForm.input}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, input: e.target.value })}
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
                  value={modelForm.output}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, output: e.target.value })}
                />
              </label>
              <label className="admin-field" style={{ flexDirection: 'row', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={modelForm.enabled}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, enabled: e.target.checked })}
                />
                启用
              </label>
              <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void saveModel()}>
                保存
              </button>
              <button type="button" className="admin-btn" disabled={busy} onClick={() => setModelForm(null)}>
                取消
              </button>
            </div>
          </section>
        )}

        <section className="admin-panel">
          <h2 className="billing-heading">厂商</h2>
          {providers.length === 0 ? (
            <p className="admin-muted">尚未在运营平台配置厂商。</p>
          ) : (
            <div className="admin-cards">
              {providers.map((p) => (
                <div className="admin-card" key={p.id}>
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">{p.name}</div>
                      <div className="admin-card-meta">{p.baseUrl}</div>
                    </div>
                    <span className="admin-muted">{p.modelCount} 个模型</span>
                  </div>
                  <div className="admin-card-meta">Key：{p.apiKeyHint ?? '未设置'}</div>
                  <div className="admin-card-meta">创建于 {formatTime(p.createdAt)}</div>
                  <div className="admin-card-actions">
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy}
                      onClick={() =>
                        setProviderForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: '' })
                      }
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy}
                      onClick={() => void removeProvider(p.id, p.name)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : models.length === 0 ? (
          <div className="admin-empty">暂无模型</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>厂商</th>
                <th>启用</th>
                <th>排序</th>
                <th>输入</th>
                <th>输出</th>
                <th>默认</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const result = testResults[m.model];
                return (
                  <tr key={m.model}>
                    <td>
                      <div>{m.displayName}</div>
                      <div className="admin-muted">{m.model}</div>
                      {result && (
                        <div className={result.ok ? 'admin-muted' : 'banner-error'} style={{ marginTop: 4 }}>
                          {result.ok ? `连接正常（${result.latencyMs}ms）` : `测试失败：${result.error ?? '未知错误'}`}
                        </div>
                      )}
                    </td>
                    <td>{m.providerName ?? '未绑定'}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        disabled={busy}
                        aria-label={`启用模型 ${m.model}`}
                        onChange={() => void toggleModel(m)}
                      />
                    </td>
                    <td className="numeric">{m.sortOrder}</td>
                    <td className="numeric">{m.inputMilliCreditsPer1k}</td>
                    <td className="numeric">{m.outputMilliCreditsPer1k}</td>
                    <td>{m.isDefault ? '★ 默认' : <button type="button" className="admin-btn" disabled={busy} onClick={() => void makeDefault(m)}>设为默认</button>}</td>
                    <td>{formatTime(m.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="admin-btn"
                        disabled={busy}
                        onClick={() =>
                          setModelForm({
                            editing: true,
                            model: m.model,
                            displayName: m.displayName,
                            providerId: m.providerId ?? providers[0]?.id ?? '',
                            enabled: m.enabled,
                            sortOrder: String(m.sortOrder),
                            input: String(m.inputMilliCreditsPer1k),
                            output: String(m.outputMilliCreditsPer1k),
                          })
                        }
                      >
                        编辑
                      </button>{' '}
                      <button type="button" className="admin-btn" disabled={busy} onClick={() => void testModel(m)}>
                        测试
                      </button>{' '}
                      <button type="button" className="admin-btn" disabled={busy} onClick={() => void removeModel(m)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
