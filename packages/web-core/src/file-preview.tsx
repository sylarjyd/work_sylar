'use client';

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { FileViewerProps } from '@file-viewer/react-full';

export interface PreviewTarget {
  blob: Blob;
  name: string;
}

export interface FilePreviewDialogProps {
  open: boolean;
  target: PreviewTarget | null;
  onClose: () => void;
  /** 预览不可用时的兜底动作（通常是下载原文件）。 */
  onFallback?: () => void;
}

type ViewerComponent = ComponentType<FileViewerProps>;

/**
 * 附件/成果在线预览：Flyfish File Viewer（@file-viewer/react-full）。
 *
 * 为什么自己包一层：
 *  - 查看器依赖 Worker/WASM，体积大，必须按需动态加载，不能进首屏；
 *  - BFF 的文件接口要带 JWT，所以先取 Blob 再交给组件，不把带鉴权的 URL 暴露给 iframe；
 *  - 加载失败时保留「下载」兜底，不让用户卡在空弹窗里。
 */
export function FilePreviewDialog({ open, target, onClose, onFallback }: FilePreviewDialogProps) {
  const [Viewer, setViewer] = useState<ViewerComponent | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || Viewer) return;
    let alive = true;
    void import('@file-viewer/react-full')
      .then((mod) => {
        if (alive) setViewer(() => mod.default as ViewerComponent);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [open, Viewer]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 查看器按扩展名判定格式：补上 MIME，避免同名不同类型的文件走错渲染器。
  const file = useMemo(() => {
    if (!target) return null;
    return new File([target.blob], target.name, {
      type: target.blob.type || 'application/octet-stream',
    });
  }, [target]);

  if (!open || !target || !file) return null;

  return (
    <div
      className="fpv-mask"
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${target.name}`}
      onClick={onClose}
    >
      <div className="fpv-panel" onClick={(event) => event.stopPropagation()}>
        <header className="fpv-head">
          <span className="fpv-name" title={target.name}>
            {target.name}
          </span>
          <span className="fpv-actions">
            {onFallback ? (
              <button type="button" className="fpv-btn" onClick={onFallback}>
                下载
              </button>
            ) : null}
            <button type="button" className="fpv-btn" onClick={onClose} aria-label="关闭预览">
              关闭
            </button>
          </span>
        </header>
        <div className="fpv-body">
          {Viewer ? (
            <Viewer
              file={file}
              name={target.name}
              options={{ theme: 'light', toolbar: { position: 'bottom-right' } }}
            />
          ) : (
            <div className="fpv-state">
              {failed ? '预览组件加载失败，请下载后查看' : '预览组件加载中…'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
