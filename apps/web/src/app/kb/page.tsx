'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KbDocDto } from '@ai-office/shared';
import { deleteKbDoc, getToken, isUnauthorized, listKbDocs, uploadKbDoc } from '../../lib/api';

export default function KbPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<KbDocDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDocs(await listKbDocs());
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

  // 存在 pending 项时轮询刷新，全部落定后停止。
  useEffect(() => {
    if (!docs.some((d) => d.status === 'pending')) return;
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [docs, refresh]);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const doc = await uploadKbDoc(file);
      setDocs((prev) => [doc, ...prev]);
      if (fileRef.current) fileRef.current.value = '';
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

  async function remove(id: string) {
    try {
      await deleteKbDoc(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(String(err));
    }
  }

  const badge: Record<KbDocDto['status'], string> = { pending: '摄取中', ready: '就绪', failed: '失败' };

  return (
    <main>
      <h1>知识库</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input ref={fileRef} type="file" accept=".txt,.md,.csv,.docx,.xlsx,.pdf" />
        <button onClick={() => void upload()} disabled={busy}>
          {busy ? '上传中…' : '上传'}
        </button>
        <button onClick={() => router.push('/')} style={{ marginLeft: 'auto' }}>
          返回工作台
        </button>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {docs.length === 0 ? (
        <p style={{ color: '#888' }}>暂无文档</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {docs.map((d) => (
            <li key={d.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>{d.filename}</div>
              <div style={{ color: '#666', fontSize: 13 }}>
                {badge[d.status]} · {d.chunkCount} 切片 · {new Date(d.createdAt).toLocaleString()}
                {d.error ? ` · ${d.error}` : ''}
              </div>
              <button style={{ marginTop: 8 }} onClick={() => void remove(d.id)}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
