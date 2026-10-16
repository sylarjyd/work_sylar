'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ConnectorDto } from '@ai-office/shared';
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

export default function ConnectorsPage() {
  const router = useRouter();
  const [items, setItems] = useState<ConnectorDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([{ key: '', value: '' }]);

  const isAdmin = getRole() === 'admin';

  const refresh = useCallback(async () => {
    try {
      setItems(await listConnectors());
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(String(err));
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
  }, [refresh, router]);

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
      setName('');
      setCommand('');
      setArgsText('');
      setEnvRows([{ key: '', value: '' }]);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: ConnectorDto) {
    try {
      const updated = await updateConnector(item.id, { enabled: !item.enabled });
      setItems((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      if (!isUnauthorized(err)) setError(String(err));
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
      setError(String(err));
    }
  }

  return (
    <main>
      <h1>连接器</h1>
      <button onClick={() => router.push('/')} style={{ marginBottom: 16 }}>
        返回工作台
      </button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {isAdmin ? (
        <section style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 16 }}>
          <h2 style={{ fontSize: 16 }}>新增 MCP Server</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
            <input placeholder="名称（租户内唯一，如 filesystem）" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="命令（如 npx）" value={command} onChange={(e) => setCommand(e.target.value)} />
            <input placeholder="参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem /data）" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            <div>
              <div style={{ fontSize: 13, color: '#666' }}>环境变量（密钥）</div>
              {envRows.map((row, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <input placeholder="KEY" value={row.key} onChange={(e) => setEnvRows((p) => p.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))} />
                  <input placeholder="VALUE" type="password" value={row.value} onChange={(e) => setEnvRows((p) => p.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
                  <button onClick={() => setEnvRows((p) => p.filter((_, j) => j !== i))}>删除</button>
                </div>
              ))}
              <button style={{ marginTop: 4 }} onClick={() => setEnvRows((p) => [...p, { key: '', value: '' }])}>+ 变量</button>
            </div>
            <button onClick={() => void submit()} disabled={busy || !name.trim() || !command.trim()}>
              {busy ? '校验中…' : '新增'}
            </button>
          </div>
        </section>
      ) : (
        <p style={{ color: '#888' }}>仅管理员可管理连接器，当前为只读。</p>
      )}

      {items.length === 0 ? (
        <p style={{ color: '#888' }}>暂无连接器</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((c) => (
            <li key={c.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div style={{ color: '#666', fontSize: 13 }}>
                {c.command} {c.args.join(' ')} · {c.toolCount} 个工具
                {c.lastValidatedAt ? ` · 校验于 ${new Date(c.lastValidatedAt).toLocaleString()}` : ''}
              </div>
              {isAdmin && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={() => void toggle(c)}>{c.enabled ? '停用' : '启用'}</button>
                  <button onClick={() => void remove(c.id)}>删除</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
