'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KbDocDto } from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import { IconBook, IconFile, IconTrash, IconUpload } from '../../components/icons';
import { deleteKbDoc, getToken, isUnauthorized, listKbDocs, uploadKbDoc } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { formatBytes } from '../../lib/format';

const ACCEPT = '.txt,.md,.csv,.docx,.xlsx,.pdf';

export default function KbPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<KbDocDto[]>([]);
  const [file, setFile] = useState<File | null>(null);
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
      setError(errorText(err));
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
    const picked = fileRef.current?.files?.[0];
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const doc = await uploadKbDoc(picked);
      setDocs((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
      if (fileRef.current) fileRef.current.value = '';
      setFile(null);
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

  async function remove(id: string) {
    try {
      await deleteKbDoc(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  const badge: Record<KbDocDto['status'], string> = {
    pending: '摄取中',
    ready: '就绪',
    failed: '失败',
  };
  const readyCount = docs.filter((d) => d.status === 'ready').length;

  return (
    <AppShell active="kb">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">知识库</h1>
              <p className="page-sub">上传文档后，智能体回答时会自动检索并引用来源。</p>
            </div>
            <div className="page-head-actions">
              <span className="status status-ready">{readyCount} 份就绪</span>
            </div>
          </header>

          {error && (
            <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          <div className="upload-card">
            <div className="upload-icon">
              <IconUpload size={20} />
            </div>
            <div className="upload-text">
              <div className="upload-title">上传知识库文档</div>
              <div className="upload-hint">
                支持 txt / md / csv / docx / xlsx / pdf，上传后自动解析并向量化。
              </div>
              {file && <div className="file-name">{file.name}</div>}
            </div>
            <input
              ref={fileRef}
              id="kb-file"
              type="file"
              accept={ACCEPT}
              className="visually-hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <label className="btn" htmlFor="kb-file">
              选择文件
            </label>
            <button
              type="button"
              className="btn btn-mint"
              onClick={() => void upload()}
              disabled={busy || !file}
            >
              {busy ? '上传中…' : '上传并摄取'}
            </button>
          </div>

          <div className="section-label">
            全部文档
            <span>{docs.length}</span>
          </div>

          {docs.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <IconBook size={22} />
              </div>
              <div className="empty-title">知识库还是空的</div>
              <div className="empty-sub">上传第一份文档，让智能体基于你的资料回答。</div>
            </div>
          ) : (
            <div className="list">
              {docs.map((d) => (
                <div key={d.id} className="card-row">
                  <div className="file-tile">
                    <IconFile size={18} />
                  </div>
                  <div className="card-main">
                    <div className="card-title">{d.filename}</div>
                    <div className="card-meta">
                      <span className={`status status-${d.status}`}>{badge[d.status]}</span>
                      <span>{d.chunkCount} 个切片</span>
                      <span className="dot-sep" />
                      <span>{formatBytes(d.size)}</span>
                      <span className="dot-sep" />
                      <span>{new Date(d.createdAt).toLocaleString('zh-CN')}</span>
                      {d.error && <span style={{ color: 'var(--danger)' }}>{d.error}</span>}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => void remove(d.id)}
                      title="删除文档"
                      aria-label={`删除 ${d.filename}`}
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
