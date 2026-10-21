'use client';

import { useEffect, useRef, useState } from 'react';
import type { ArtifactDto } from '@ai-office/shared';
import { formatBytes } from '../lib/format';
import { IconDownload, IconX } from './icons';

interface ArtifactDrawerProps {
  open: boolean;
  artifacts: ArtifactDto[];
  onClose: () => void;
  onDownload: (artifact: ArtifactDto) => void;
}

export function ArtifactDrawer({ open, artifacts, onClose, onDownload }: ArtifactDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // aria-modal 只在窄屏（带遮罩）时生效，避免把桌面端非模态抽屉误报为模态。
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreRef.current?.focus();
    };
  }, [open]);

  return (
    <div className={`wb-drawer-layer${open ? ' open' : ''}`} aria-hidden={!open} inert={!open}>
      <div className="wb-drawer-backdrop" onClick={onClose} />
      <aside
        className="wb-drawer"
        role="dialog"
        aria-label="成果"
        aria-modal={narrow ? true : undefined}
      >
        <header className="wb-drawer-head">
          <div>
            <div className="wb-drawer-title">成果</div>
            <div className="wb-drawer-sub">
              {artifacts.length > 0 ? `${artifacts.length} 个文件` : '任务产出'}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="wb-icon-btn"
            onClick={onClose}
            aria-label="关闭成果面板"
            title="关闭"
          >
            <IconX size={16} />
          </button>
        </header>

        <div className="wb-drawer-body">
          {artifacts.length === 0 ? (
            <div className="wb-drawer-empty">任务产出的文档会出现在这里</div>
          ) : (
            <div className="wb-artifact-list">
              {artifacts.map((a, i) => (
                <div key={a.id || `pending-${i}`} className="wb-artifact-card">
                  <div className={`wb-artifact-icon ${a.kind}`}>{a.kind.toUpperCase()}</div>
                  <div className="wb-artifact-main">
                    <div className="wb-artifact-name">{a.filename}</div>
                    <div className="wb-artifact-meta">
                      {formatBytes(a.size)} · v{a.version || 0} ·{' '}
                      {new Date(a.createdAt).toLocaleString('zh-CN')}
                    </div>
                    {a.id ? (
                      <button type="button" className="wb-download" onClick={() => onDownload(a)}>
                        <IconDownload size={13} />
                        下载
                      </button>
                    ) : (
                      <span className="wb-artifact-meta">落库中…</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
