'use client';

import { useEffect, useRef, useState } from 'react';
import type { ArtifactDto, SessionChartDto } from '@ai-office/shared';
import { EChart, buildChartOption } from '@ai-office/web-core/chart';
import { formatBytes } from '../lib/format';
import { IconChevron, IconDownload, IconEye, IconFolder, IconX } from './icons';

interface ArtifactDrawerProps {
  open: boolean;
  artifacts: ArtifactDto[];
  /** 会话内持久化的图表：和文档一起出现在成果栏，点开可放大查看。 */
  charts?: SessionChartDto[];
  /** 正在取字节的文件 id：按钮进入 loading/禁用态，避免连点重复下载。 */
  previewingId?: string;
  onPreview?: (artifact: ArtifactDto) => void;
  onClose: () => void;
  onDownload: (artifact: ArtifactDto) => void;
}

/** 文档类直接显示类型；文本类（代码/表格/说明）更直观地显示扩展名。 */
function kindLabel(a: ArtifactDto): string {
  if (a.kind !== 'text') return a.kind.toUpperCase();
  const ext = extOf(a.filename);
  return ext ? ext.slice(0, 5).toUpperCase() : 'TXT';
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

const CODE_EXT = new Set([
  'java',
  'kt',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'rb',
  'sh',
  'bat',
  'ps1',
  'vue',
  'html',
  'htm',
  'css',
  'scss',
  'sql',
]);

const CONFIG_EXT = new Set(['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'properties', 'gradle']);
const SHEET_EXT = new Set(['csv', 'tsv']);

interface FolderDef {
  key: string;
  label: string;
}

/** 成果没有目录信息，按产物类型归档成一级文件夹，目录结构稳定且一眼可辨。 */
const FOLDERS: FolderDef[] = [
  { key: 'doc', label: '文档' },
  { key: 'sheet', label: '表格' },
  { key: 'slides', label: '演示文稿' },
  { key: 'code', label: '代码' },
  { key: 'config', label: '配置' },
];

function folderOf(a: ArtifactDto): string {
  if (a.kind === 'docx') return 'doc';
  if (a.kind === 'xlsx') return 'sheet';
  if (a.kind === 'pptx') return 'slides';
  const ext = extOf(a.filename);
  if (CODE_EXT.has(ext)) return 'code';
  if (CONFIG_EXT.has(ext)) return 'config';
  if (SHEET_EXT.has(ext)) return 'sheet';
  return 'doc';
}

function groupArtifacts(artifacts: ArtifactDto[]): { def: FolderDef; items: ArtifactDto[] }[] {
  const buckets = new Map<string, ArtifactDto[]>();
  for (const a of artifacts) {
    const key = folderOf(a);
    const list = buckets.get(key);
    if (list) list.push(a);
    else buckets.set(key, [a]);
  }
  return FOLDERS.filter((f) => buckets.has(f.key)).map((def) => ({
    def,
    items: buckets.get(def.key) ?? [],
  }));
}

/**
 * 成果栏是对话区右侧的固定一列：展开时挤压正文而不是浮在上面，
 * 因此不需要遮罩、焦点陷阱和 body 滚动锁。
 */
export function ArtifactDrawer({
  open,
  artifacts,
  charts = [],
  previewingId = '',
  onPreview,
  onClose,
  onDownload,
}: ArtifactDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const asideRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<SessionChartDto | null>(null);
  // 面板宽度可拖动：null 表示用 CSS 默认宽（窄屏还受媒体查询约束）。
  const [width, setWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem('wb.drawer.width'));
    if (Number.isFinite(stored) && stored >= 320) setWidth(Math.min(stored, 760));
  }, []);

  function clampWidth(next: number): number {
    return Math.max(320, Math.min(760, Math.min(next, window.innerWidth * 0.7)));
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>): void {
    const aside = asideRef.current;
    if (!aside) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: aside.getBoundingClientRect().width };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onResize(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    // 面板在右侧：指针左移（clientX 变小）时变宽。
    setWidth(clampWidth(drag.startWidth + (drag.startX - e.clientX)));
  }

  function endResize(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setWidth((current) => {
      if (current !== null) window.localStorage.setItem('wb.drawer.width', String(current));
      return current;
    });
  }

  function resetWidth(): void {
    setWidth(null);
    window.localStorage.removeItem('wb.drawer.width');
  }

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // 预览层优先关闭，避免一次 Esc 把整个成果栏也收起来。
        if (preview) setPreview(null);
        else onCloseRef.current();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, preview]);

  const folders = groupArtifacts(artifacts);

  return (
    <div className={`wb-drawer-layer${open ? ' open' : ''}`} aria-hidden={!open} inert={!open}>
      <aside
        id="wb-artifacts-panel"
        ref={asideRef}
        className="wb-drawer"
        aria-label="成果"
        style={width === null ? undefined : { width, flexBasis: width }}
      >
        <div
          className="wb-drawer-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整成果面板宽度"
          title="拖动调整宽度，双击恢复默认"
          onPointerDown={startResize}
          onPointerMove={onResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetWidth}
        />
        <header className="wb-drawer-head">
          <div>
            <div className="wb-drawer-title">成果</div>
            <div className="wb-drawer-sub">
              {artifacts.length + charts.length > 0
                ? `${artifacts.length + charts.length} 个产出 · ${folders.length + (charts.length > 0 ? 1 : 0)} 个文件夹`
                : '任务产出'}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="wb-icon-btn"
            onClick={onClose}
            aria-label="收起成果栏"
            title="收起"
          >
            <IconX size={16} />
          </button>
        </header>

        <div className="wb-drawer-body">
          {artifacts.length === 0 && charts.length === 0 ? (
            <div className="wb-drawer-empty">任务产出的文档与图表会出现在这里</div>
          ) : (
            <div className="wb-tree">
              {charts.length > 0 && (
                <section className="wb-tree-folder">
                  <button
                    type="button"
                    className="wb-tree-folder-head"
                    aria-expanded={!collapsed.charts}
                    onClick={() =>
                      setCollapsed((prev) => ({ ...prev, charts: !prev.charts }))
                    }
                  >
                    <IconChevron
                      size={14}
                      className={`wb-tree-caret${collapsed.charts ? ' collapsed' : ''}`}
                    />
                    <IconFolder size={15} className="wb-tree-folder-icon" />
                    <span className="wb-tree-folder-name">图表</span>
                    <span className="wb-tree-folder-count">{charts.length}</span>
                  </button>
                  {!collapsed.charts && (
                    <div className="wb-tree-files">
                      {charts.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="wb-tree-file wb-tree-file-btn"
                          onClick={() => setPreview(c)}
                          title={`查看图表：${c.title}`}
                        >
                          <div className="wb-file-badge chart">图</div>
                          <div className="wb-file-body">
                            <div className="wb-file-name">{c.title}</div>
                            <div className="wb-file-meta">
                              {new Date(c.createdAt).toLocaleString('zh-CN')}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {folders.map(({ def, items }) => {
                const isCollapsed = !!collapsed[def.key];
                return (
                  <section key={def.key} className="wb-tree-folder">
                    <button
                      type="button"
                      className="wb-tree-folder-head"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((prev) => ({ ...prev, [def.key]: !prev[def.key] }))
                      }
                    >
                      <IconChevron
                        size={14}
                        className={`wb-tree-caret${isCollapsed ? ' collapsed' : ''}`}
                      />
                      <IconFolder size={15} className="wb-tree-folder-icon" />
                      <span className="wb-tree-folder-name">{def.label}</span>
                      <span className="wb-tree-folder-count">{items.length}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="wb-tree-files">
                        {items.map((a, i) => (
                          <div key={a.id || `pending-${def.key}-${i}`} className="wb-tree-file">
                            <div className={`wb-file-badge ${a.kind}`}>{kindLabel(a)}</div>
                            <div className="wb-file-body">
                              <div className="wb-file-name" title={a.filename}>
                                {a.filename}
                              </div>
                              <div className="wb-file-meta">
                                {formatBytes(a.size)} · v{a.version || 0} ·{' '}
                                {new Date(a.createdAt).toLocaleString('zh-CN')}
                              </div>
                            </div>
                            {a.id ? (
                              <>
                                {onPreview ? (
                                  <button
                                    type="button"
                                    className="wb-file-dl"
                                    onClick={() => onPreview(a)}
                                    disabled={previewingId === a.id}
                                    aria-label={`预览 ${a.filename}`}
                                    title="预览"
                                  >
                                    <IconEye size={14} />
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="wb-file-dl"
                                  onClick={() => onDownload(a)}
                                  aria-label={`下载 ${a.filename}`}
                                  title="下载"
                                >
                                  <IconDownload size={14} />
                                </button>
                              </>
                            ) : (
                              <span className="wb-file-pending">落库中</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </aside>
      {preview && (
        <div
          className="wb-chart-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`图表：${preview.title}`}
          onClick={() => setPreview(null)}
        >
          <div className="wb-chart-preview-body" onClick={(e) => e.stopPropagation()}>
            <header className="wb-chart-preview-head">
              <span className="wb-chart-preview-title">{preview.title}</span>
              <button
                type="button"
                className="wb-icon-btn"
                onClick={() => setPreview(null)}
                aria-label="关闭图表预览"
              >
                <IconX size={16} />
              </button>
            </header>
            <EChart option={buildChartOption(preview.spec)} height={360} />
          </div>
        </div>
      )}
    </div>
  );
}
