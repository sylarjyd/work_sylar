'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminModelDto,
  AdminPlanDto,
  AdminPlanInput,
  AdminPlanPatch,
} from '@ai-office/shared';
import {
  adminErrorText,
  createAdminPlan,
  getAdminModels,
  isForbidden,
  listAdminPlans,
  updateAdminPlan,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const EMPTY: AdminPlanInput = {
  id: '',
  name: '',
  priceCents: 0,
  monthlyBaseCredits: 0,
  monthlyBonusCredits: 0,
  maxCreditsPerRun: 0,
  rpm: 0,
  allowedModels: [],
  active: true,
};

export default function AdminPlansPage() {
  const router = useRouter();
  const [plans, setPlans] = useState<AdminPlanDto[]>([]);
  const [form, setForm] = useState<AdminPlanInput>(EMPTY);
  const [catalog, setCatalog] = useState<AdminModelDto[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
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
      const rows = await listAdminPlans();
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setPlans(rows);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // 模型目录用于勾选允许模型；停用模型仍展示，避免历史套餐丢失引用。
  useEffect(() => {
    let cancelled = false;
    getAdminModels()
      .then((data) => {
        if (!cancelled) setCatalog(data.models);
      })
      .catch((err) => {
        if (!cancelled) setCatalogError(adminErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  function startEdit(plan: AdminPlanDto) {
    setEditing(plan.id);
    setForm({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      monthlyBaseCredits: plan.monthlyBaseCredits,
      monthlyBonusCredits: plan.monthlyBonusCredits,
      maxCreditsPerRun: plan.maxCreditsPerRun,
      rpm: plan.rpm,
      allowedModels: plan.allowedModels,
      active: plan.active,
    });
  }

  function resetForm() {
    setEditing(null);
    setForm(EMPTY);
  }

  async function save() {
    if (inFlight.current) return;
    setError('');
    setNotice('');
    const payload: AdminPlanInput = {
      ...form,
      allowedModels: form.allowedModels,
    };
    if (!payload.name.trim()) {
      setError('套餐名称不能为空');
      return;
    }
    if (payload.allowedModels.length === 0) {
      setError('请至少选择一个允许模型');
      return;
    }
    const verb = editing ? '保存修改' : '创建套餐';
    if (!window.confirm(`确认${verb} ${payload.name}？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) {
        // 标识是主键，更新时不可变。
        const patch: AdminPlanPatch = {
          name: payload.name,
          priceCents: payload.priceCents,
          monthlyBaseCredits: payload.monthlyBaseCredits,
          monthlyBonusCredits: payload.monthlyBonusCredits,
          maxCreditsPerRun: payload.maxCreditsPerRun,
          rpm: payload.rpm,
          allowedModels: payload.allowedModels,
          active: payload.active,
        };
        await updateAdminPlan(editing, patch);
      } else {
        await createAdminPlan(payload);
      }
      resetForm();
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

  async function deactivate(plan: AdminPlanDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认停用套餐 ${plan.name}？`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await updateAdminPlan(plan.id, { active: false });
      // 表单若正编辑该套餐，需重置，避免残留的 active: true 在后续保存时把套餐重新启用
      if (editing === plan.id) resetForm();
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

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">套餐目录</h1>
            <p className="page-sub">停用代替删除；免费套餐不可停用。</p>
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
          <h2 className="billing-heading">{editing ? `编辑 ${editing}` : '新建套餐'}</h2>
          <div className="admin-form">
            <label className="admin-field">
              标识（slug）
              <input
                className="admin-input"
                value={form.id}
                disabled={!!editing || busy}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
            </label>
            <label className="admin-field">
              名称
              <input className="admin-input" value={form.name} disabled={busy} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="admin-field">
              价格（分/月）
              <input className="admin-input" type="number" min={0} step={1} value={form.priceCents} disabled={busy} onChange={(e) => setForm({ ...form, priceCents: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              月度基础积分
              <input className="admin-input" type="number" min={0} step={1} value={form.monthlyBaseCredits} disabled={busy} onChange={(e) => setForm({ ...form, monthlyBaseCredits: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              月度赠送积分
              <input className="admin-input" type="number" min={0} step={1} value={form.monthlyBonusCredits} disabled={busy} onChange={(e) => setForm({ ...form, monthlyBonusCredits: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              单次上限
              <input className="admin-input" type="number" min={0} step={1} value={form.maxCreditsPerRun} disabled={busy} onChange={(e) => setForm({ ...form, maxCreditsPerRun: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              RPM
              <input className="admin-input" type="number" min={0} step={1} value={form.rpm} disabled={busy} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
            </label>
            <div className="admin-field" style={{ minWidth: 280 }}>
              允许模型
              {catalogError && <span className="banner-error">{catalogError}</span>}
              <div className="admin-checks">
                {[
                  ...catalog,
                  ...form.allowedModels
                    .filter((m) => !catalog.some((c) => c.model === m))
                    .map((model) => ({
                      model,
                      displayName: model,
                      enabled: false,
                      providerName: null,
                    })),
                ].map((m) => {
                  const checked = form.allowedModels.includes(m.model);
                  return (
                    <label className="admin-check" key={m.model}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            allowedModels: e.target.checked
                              ? [...form.allowedModels, m.model]
                              : form.allowedModels.filter((x) => x !== m.model),
                          })
                        }
                      />
                      <span>
                        {m.displayName || m.model}
                        {!m.enabled ? '（已停用）' : ''}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <label className="admin-field">
              启用
              <input type="checkbox" checked={form.active} disabled={busy} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            </label>
            <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void save()}>
              {editing ? '保存' : '创建'}
            </button>
            {editing && (
              <button type="button" className="admin-btn" disabled={busy} onClick={resetForm}>
                取消
              </button>
            )}
          </div>
        </section>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>标识</th>
                <th>名称</th>
                <th>价格</th>
                <th>额度</th>
                <th>单次上限</th>
                <th>RPM</th>
                <th>模型</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{p.name}</td>
                  <td className="numeric">{p.priceCents}</td>
                  <td className="numeric">{p.monthlyBaseCredits + p.monthlyBonusCredits}</td>
                  <td className="numeric">{p.maxCreditsPerRun}</td>
                  <td className="numeric">{p.rpm}</td>
                  <td>{p.allowedModels.join('、')}</td>
                  <td>{p.active ? '启用' : '停用'}</td>
                  <td>
                    <button type="button" className="admin-btn" disabled={busy} onClick={() => startEdit(p)}>
                      编辑
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy || p.id === 'free' || !p.active}
                      onClick={() => void deactivate(p)}
                    >
                      停用
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
