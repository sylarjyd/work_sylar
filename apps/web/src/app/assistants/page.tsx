'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ASSISTANT_PERMISSION_MODES,
  ASSISTANT_PERMISSION_MODE_HINTS,
  ASSISTANT_PERMISSION_MODE_LABELS,
  ASSISTANT_SKILLS,
  type AssistantDto,
  type AssistantInput,
  type AssistantPermissionMode,
  type ClientModelDto,
  type KbDocDto,
} from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import { IconPlus, IconSpark, IconTrash } from '../../components/icons';
import {
  createAssistant,
  deleteAssistant,
  getToken,
  isUnauthorized,
  listAssistants,
  listKbDocs,
  listModels,
  updateAssistant,
} from '../../lib/api';
import { errorText } from '@ai-office/web-core';

interface FormState {
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  model: string;
  skills: string[];
  kbDocIds: string[];
}

const EMPTY: FormState = {
  name: '',
  description: '',
  systemPrompt: '',
  permissionMode: 'standard',
  model: '',
  skills: ASSISTANT_SKILLS.map((s) => s.key),
  kbDocIds: [],
};

export default function AssistantsPage() {
  const router = useRouter();
  const [assistants, setAssistants] = useState<AssistantDto[]>([]);
  const [models, setModels] = useState<ClientModelDto[]>([]);
  const [docs, setDocs] = useState<KbDocDto[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    },
    [router],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, modelData, kbDocs] = await Promise.all([
        listAssistants(),
        listModels(),
        listKbDocs(),
      ]);
      setAssistants(rows);
      setModels(modelData.models);
      setDocs(kbDocs);
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
  }, [refresh, router]);

  function resetForm() {
    setEditing(null);
    setForm(EMPTY);
    setError('');
  }

  function startEdit(a: AssistantDto) {
    setEditing(a.id);
    setForm({
      name: a.name,
      description: a.description,
      systemPrompt: a.systemPrompt,
      permissionMode: a.permissionMode,
      model: a.model ?? '',
      skills: a.skills,
      kbDocIds: a.kbDocIds,
    });
    setError('');
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  }

  async function save() {
    if (inFlight.current) return;
    setError('');
    const name = form.name.trim();
    if (!name) {
      setError('助手名称不能为空');
      return;
    }
    const payload: AssistantInput = {
      name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      permissionMode: form.permissionMode,
      model: form.model || null,
      skills: form.skills,
      kbDocIds: form.kbDocIds,
    };
    const verb = editing ? '保存修改' : '创建助手';
    if (!window.confirm(`确认${verb}「${name}」？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) await updateAssistant(editing, payload);
      else await createAssistant(payload);
      resetForm();
      await refresh();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function remove(a: AssistantDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认删除助手「${a.name}」？已创建的历史任务会退化为默认助手。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteAssistant(a.id);
      if (editing === a.id) resetForm();
      setAssistants((prev) => prev.filter((x) => x.id !== a.id));
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const skillLabels = (keys: string[]): string =>
    ASSISTANT_SKILLS.filter((s) => keys.includes(s.key))
      .map((s) => s.name)
      .join('、') || '未绑定技能';

  return (
    <AppShell active="assistants">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">我的助手</h1>
              <p className="page-sub">
                创建专属助手：设定系统提示词、技能、权限模式、默认模型与可检索的知识库范围。
              </p>
            </div>
            <div className="page-head-actions">
              <button type="button" className="btn btn-mint" disabled={busy} onClick={resetForm}>
                <IconPlus size={15} />
                新建助手
              </button>
            </div>
          </header>

          {error && (
            <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          <section className="admin-panel">
            <h2 className="billing-heading">{editing ? `编辑 ${form.name}` : '新建助手'}</h2>
            <div className="admin-form">
              <label className="admin-field">
                名称
                <input
                  className="admin-input"
                  value={form.name}
                  maxLength={40}
                  disabled={busy}
                  placeholder="如：合同审阅助手"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="admin-field">
                简介
                <input
                  className="admin-input"
                  value={form.description}
                  maxLength={200}
                  disabled={busy}
                  placeholder="一句话说明这个助手擅长什么"
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>
              <label className="admin-field">
                默认模型
                <select
                  className="admin-input"
                  value={form.model}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                >
                  <option value="">跟随运营端默认模型</option>
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.displayName && m.displayName !== m.model
                        ? `${m.displayName} · ${m.model}`
                        : m.model}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                权限模式
                <select
                  className="admin-input"
                  value={form.permissionMode}
                  disabled={busy}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      permissionMode: e.target.value as AssistantPermissionMode,
                    })
                  }
                >
                  {ASSISTANT_PERMISSION_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {ASSISTANT_PERMISSION_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
                <span className="page-sub">{ASSISTANT_PERMISSION_MODE_HINTS[form.permissionMode]}</span>
              </label>
              <div className="admin-field" style={{ minWidth: 280 }}>
                技能
                <div className="admin-checks">
                  {ASSISTANT_SKILLS.map((s) => (
                    <label className="admin-check" key={s.key} title={s.description}>
                      <input
                        type="checkbox"
                        checked={form.skills.includes(s.key)}
                        disabled={busy}
                        onChange={() => setForm({ ...form, skills: toggle(form.skills, s.key) })}
                      />
                      <span>
                        {s.name}
                        <span className="page-sub"> · {s.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="admin-field" style={{ minWidth: 280 }}>
                知识库范围
                <span className="page-sub">
                  {form.kbDocIds.length === 0
                    ? '未选择时检索全部已上传文档'
                    : `仅检索已选的 ${form.kbDocIds.length} 份文档`}
                </span>
                {docs.length === 0 ? (
                  <span className="page-sub">知识库暂无文档，可稍后在「知识库」页上传。</span>
                ) : (
                  <div className="admin-checks">
                    {docs.map((d) => (
                      <label className="admin-check" key={d.id}>
                        <input
                          type="checkbox"
                          checked={form.kbDocIds.includes(d.id)}
                          disabled={busy}
                          onChange={() =>
                            setForm({ ...form, kbDocIds: toggle(form.kbDocIds, d.id) })
                          }
                        />
                        <span>
                          {d.filename}
                          {d.status !== 'ready' ? `（${d.status === 'pending' ? '摄取中' : '失败'}）` : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <label className="admin-field" style={{ flexBasis: '100%' }}>
                系统提示词
                <textarea
                  className="admin-input"
                  rows={8}
                  maxLength={8000}
                  value={form.systemPrompt}
                  disabled={busy}
                  placeholder="描述助手的角色、目标、工作方式与输出要求。例如：你是资深合同审阅助手，逐条指出风险条款并给出修改建议…"
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                />
              </label>
              <div className="admin-field">
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                    {editing ? '保存' : '创建助手'}
                  </button>
                  {editing && (
                    <button type="button" className="btn" disabled={busy} onClick={resetForm}>
                      取消
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          <div className="section-label">
            全部助手
            <span>{assistants.length}</span>
          </div>

          {loading ? (
            <div className="empty">
              <div className="empty-title">加载中…</div>
            </div>
          ) : assistants.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <IconSpark size={22} />
              </div>
              <div className="empty-title">还没有自定义助手</div>
              <div className="empty-sub">新建助手后，可在工作台新建任务时选择它。</div>
            </div>
          ) : (
            <div className="list">
              {assistants.map((a) => (
                <div key={a.id} className="card-row">
                  <div className="file-tile">
                    <IconSpark size={18} />
                  </div>
                  <div className="card-main">
                    <div className="card-title">{a.name}</div>
                    <div className="card-meta">
                      <span>{skillLabels(a.skills)}</span>
                      <span className="dot-sep" />
                      <span>{ASSISTANT_PERMISSION_MODE_LABELS[a.permissionMode].split('：')[0]}</span>
                      <span className="dot-sep" />
                      <span>{a.model || '默认模型'}</span>
                      <span className="dot-sep" />
                      <span>{a.kbDocIds.length === 0 ? '全部知识库' : `${a.kbDocIds.length} 份文档`}</span>
                    </div>
                    {a.description && <div className="card-meta">{a.description}</div>}
                  </div>
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => startEdit(a)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      disabled={busy}
                      onClick={() => void remove(a)}
                      title="删除助手"
                      aria-label={`删除 ${a.name}`}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
