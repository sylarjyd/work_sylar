'use client';

import { useEffect, useRef } from 'react';
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
  const drawerRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = drawerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      if (restoreRef.current?.isConnected) restoreRef.current.focus();
    };
  }, [open]);

  return (
    <div className={`wb-drawer-layer${open ? ' open' : ''}`} aria-hidden={!open} inert={!open}>
      <div className="wb-drawer-backdrop" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="wb-drawer"
        role="dialog"
        aria-label="成果"
        aria-modal={open ? true : undefined}
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
