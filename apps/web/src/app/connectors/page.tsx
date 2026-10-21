'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ConnectorDto } from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import { IconLock, IconPlug, IconPlus, IconTrash, IconX } from '../../components/icons';
import { errorText } from '@ai-office/web-core';
import {
  createConnector,
  deleteConnector,
  getRole,
  getToken,
  isUnauthorized,
  listConnectors,
  updateConnector,
} from '../../lib/api';

type EnvRow = { key: string; value: string };

const EMPTY_ENV: EnvRow[] = [{ key: '', value: '' }];

export default function ConnectorsPage() {
  const router = useRouter();
  const [items, setItems] = useState<ConnectorDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>(EMPTY_ENV);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listConnectors());
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    const role = getRole();
    if (role === 'admin') {
      setIsAdmin(true);
      void refresh();
      return;
    }
    if (role) {
      // 普通成员无权读取连接器列表：不发起请求，避免无意义的 403 报错。
      setIsAdmin(false);
      return;
    }
    // 旧 token 未记录角色：用一次拉取探测权限，403 视为普通成员。
    void (async () => {
      try {
        setItems(await listConnectors());
        setIsAdmin(true);
      } catch (err) {
        if (isUnauthorized(err)) {
          router.push('/login');
          return;
        }
        if (err instanceof Error && err.message === 'connectors_failed_403') {
          setIsAdmin(false);
          return;
        }
        setIsAdmin(false);
        setError(errorText(err));
      }
    })();
  }, [refresh, router]);

  function resetForm() {
    setName('');
    setCommand('');
    setArgsText('');
    setEnvRows(EMPTY_ENV);
    setShowForm(false);
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const env = Object.fromEntries(
        envRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
      );
      const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      const created = await createConnector({ name: name.trim(), command: command.trim(), args, env });
      setItems((prev) => [created, ...prev]);
      resetForm();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: ConnectorDto) {
    try {
      const updated = await updateConnector(item.id, { enabled: !item.enabled });
      setItems((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function remove(id: string) {
    try {
      await deleteConnector(id);
      setItems((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  return (
    <AppShell active="connectors">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">连接器</h1>
              <p className="page-sub">
                接入外部 MCP Server，其工具会自动出现在智能体的工具箱里。
              </p>
            </div>
            {isAdmin && (
              <div className="page-head-actions">
                <button
                  type="button"
                  className={showForm ? 'btn btn-ghost' : 'btn btn-primary'}
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? <IconX size={15} /> : <IconPlus size={15} />}
                  {showForm ? '收起' : '新增连接器'}
                </button>
              </div>
            )}
          </header>

          {error && (
            <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          {isAdmin === null ? null : !isAdmin ? (
            <div className="notice">
              <div className="notice-icon">
                <IconLock size={18} />
              </div>
              <div>
                <div className="notice-title">需要管理员权限</div>
                <div className="notice-text">
                  连接器由管理员统一配置。如需接入新的 MCP Server，请联系所在组织的管理员。
                </div>
              </div>
            </div>
          ) : (
            <>
              {showForm && (
                <section className="panel">
                  <h2 className="panel-title">新增 MCP Server</h2>
                  <p className="panel-sub">
                    保存前会实际拉起子进程校验工具列表；校验失败不会入库。
                  </p>
                  <div className="form-grid">
                    <div className="field">
                      <label className="field-label" htmlFor="connector-name">
                        名称
                      </label>
                      <input
                        id="connector-name"
                        className="input"
                        placeholder="租户内唯一，如 filesystem"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="connector-command">
                        启动命令
                      </label>
                      <input
                        id="connector-command"
                        className="input"
                        placeholder="如 npx"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                      />
                    </div>
                    <div className="field span-2">
                      <label className="field-label" htmlFor="connector-args">
                        参数
                      </label>
                      <input
                        id="connector-args"
                        className="input"
                        placeholder="-y @modelcontextprotocol/server-filesystem /data"
                        value={argsText}
                        onChange={(e) => setArgsText(e.target.value)}
                      />
                    </div>
                    <div className="field span-2">
                      <span className="field-label">环境变量（密钥加密入库）</span>
                      <div className="env-list">
                        {envRows.map((row, i) => (
                          <div key={i} className="env-row">
                            <input
                              className="input"
                              placeholder="变量名"
                              value={row.key}
                              onChange={(e) =>
                                setEnvRows((p) =>
                                  p.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                                )
                              }
                            />
                            <input
                              className="input"
                              placeholder="变量值"
                              type="password"
                              value={row.value}
                              onChange={(e) =>
                                setEnvRows((p) =>
                                  p.map((r, j) =>
                                    j === i ? { ...r, value: e.target.value } : r,
                                  ),
                                )
                              }
                            />
                            <button
                              type="button"
                              className="icon-btn danger"
                              onClick={() => setEnvRows((p) => p.filter((_, j) => j !== i))}
                              title="删除变量"
                              aria-label="删除变量"
                            >
                              <IconTrash size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <div>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setEnvRows((p) => [...p, { key: '', value: '' }])}
                        >
                          <IconPlus size={13} />
                          添加变量
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn-mint"
                      onClick={() => void submit()}
                      disabled={busy || !name.trim() || !command.trim()}
                    >
                      {busy ? '校验中…' : '校验并添加'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={resetForm}>
                      取消
                    </button>
                  </div>
                </section>
              )}

              {items.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">
                    <IconPlug size={22} />
                  </div>
                  <div className="empty-title">还没有连接器</div>
                  <div className="empty-sub">
                    新增一个 MCP Server 后，其工具会自动出现在智能体的工具箱里。
                  </div>
                </div>
              ) : (
                <div className="list">
                  {items.map((c) => (
                    <div key={c.id} className="card-row">
                      <div className="file-tile">
                        <IconPlug size={18} />
                      </div>
                      <div className="card-main">
                        <div className="card-title">{c.name}</div>
                        <div className="card-meta">
                          <span className={c.enabled ? 'status status-ready' : 'status status-off'}>
                            {c.enabled ? '已启用' : '已停用'}
                          </span>
                          <span>{c.toolCount} 个工具</span>
                          {c.lastValidatedAt && (
                            <>
                              <span className="dot-sep" />
                              <span>校验于 {new Date(c.lastValidatedAt).toLocaleString()}</span>
                            </>
                          )}
                        </div>
                        <div className="card-command">
                          {c.command} {c.args.join(' ')}
                        </div>
                      </div>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void toggle(c)}
                        >
                          {c.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          onClick={() => void remove(c.id)}
                          title="删除连接器"
                          aria-label={`删除 ${c.name}`}
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
