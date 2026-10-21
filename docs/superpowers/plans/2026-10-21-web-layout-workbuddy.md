# 客户端工作台对标 WorkBuddy 布局改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把客户端工作台的外壳、新任务页、会话页与成果区改成 WorkBuddy 式的「灰底侧栏 + 白色主区 + 无卡片对话流 + 底部大输入框 + 右侧按需抽屉」。

**Architecture:** 保留现有 `AppShell` 与页面状态逻辑，新增 `wb-` 作用域样式，运营端共用的 `.shell/.sidebar` 语义不变。纯逻辑（相对时间、会话筛选）抽成可单测函数；成果区抽成独立 `ArtifactDrawer` 组件。业务 API、SSE、数据库完全不动。

**Tech Stack:** Next.js 15 App Router、React 19、TypeScript、Vitest、纯 CSS（`packages/web-core/src/globals.css`）。

**设计文档:** `docs/superpowers/specs/2026-10-21-web-layout-workbuddy-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `apps/web/src/lib/format.ts` | 已有的 `formatBytes`；新增 `relativeTime` |
| `apps/web/src/lib/format.test.ts` | `relativeTime` 单测 |
| `apps/web/src/lib/session-filter.ts` | 会话标题过滤纯函数 |
| `apps/web/src/lib/session-filter.test.ts` | 会话过滤单测 |
| `packages/web-core/src/auth.ts` | 登录时持久化邮箱，新增 `getEmail()` |
| `packages/web-core/src/auth.test.ts` | 新增：清理登录态时同时清邮箱 |
| `apps/web/src/lib/api.ts` | re-export `getEmail` |
| `apps/web/src/components/icons.tsx` | 新增搜索、侧栏、网格、复制、外链箭头图标 |
| `apps/web/src/components/artifact-drawer.tsx` | 新增：成果抽屉 |
| `apps/web/src/components/app-shell.tsx` | 侧栏改版：折叠、搜索、最近列表、用户区 |
| `apps/web/src/app/page.tsx` | 顶部栏、对话流、空态、输入框、抽屉集成、复制 |
| `packages/web-core/src/globals.css` | 追加 `.wb-*` 作用域样式与令牌 |

---

### Task 1: 相对时间与会话过滤纯函数

**Files:**
- Modify: `apps/web/src/lib/format.ts`
- Create: `apps/web/src/lib/format.test.ts`
- Create: `apps/web/src/lib/session-filter.ts`
- Create: `apps/web/src/lib/session-filter.test.ts`

- [ ] **Step 1: 写 `relativeTime` 失败测试**

创建 `apps/web/src/lib/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { relativeTime } from './format';

// 用本地时间构造，避免测试机时区不同导致「日期」断言的跨天抖动。
const NOW = new Date(2026, 9, 21, 12, 0, 0);

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('relativeTime', () => {
  it('60 秒内显示「刚刚」', () => {
    expect(relativeTime(ago(30_000), NOW)).toBe('刚刚');
  });

  it('1 小时内按分钟显示', () => {
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5 分钟前');
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe('59 分钟前');
  });

  it('24 小时内按小时显示', () => {
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3 小时前');
  });

  it('7 天内按天显示', () => {
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2 天前');
    expect(relativeTime(ago(6 * 86_400_000), NOW)).toBe('6 天前');
  });

  it('超过 7 天回退为本地日期', () => {
    expect(relativeTime(new Date(2026, 9, 1, 12).toISOString(), NOW)).toBe('2026-10-01');
  });

  it('未来时间按「刚刚」处理，非法时间返回空串', () => {
    expect(relativeTime(new Date(NOW.getTime() + 10_000).toISOString(), NOW)).toBe('刚刚');
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/format.test.ts`

Expected: FAIL，提示 `relativeTime is not a function` 或导入不存在。

- [ ] **Step 3: 实现 `relativeTime`**

修改 `apps/web/src/lib/format.ts`，在文件末尾追加：

```ts
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 会话列表的相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；超过 7 天显示本地日期。 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = now.getTime() - ts;
  if (diff < MINUTE_MS) return '刚刚';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-office/web test -- src/lib/format.test.ts`

Expected: PASS，6 个用例全绿。

- [ ] **Step 5: 写会话过滤失败测试**

创建 `apps/web/src/lib/session-filter.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@ai-office/shared';
import { filterSessions } from './session-filter';

const SESSIONS: SessionSummary[] = [
  { id: '1', title: '写一份周报', createdAt: '2026-10-21T04:00:00.000Z' },
  { id: '2', title: '调研竞品 WorkBuddy', createdAt: '2026-10-20T04:00:00.000Z' },
  { id: '3', title: '生成演示稿', createdAt: '2026-10-19T04:00:00.000Z' },
];

describe('filterSessions', () => {
  it('空关键字返回原列表', () => {
    expect(filterSessions(SESSIONS, '')).toBe(SESSIONS);
    expect(filterSessions(SESSIONS, '   ')).toBe(SESSIONS);
  });

  it('按标题做大小写不敏感的子串匹配', () => {
    expect(filterSessions(SESSIONS, 'workbuddy').map((s) => s.id)).toEqual(['2']);
    expect(filterSessions(SESSIONS, '周报').map((s) => s.id)).toEqual(['1']);
  });

  it('去除首尾空格后匹配', () => {
    expect(filterSessions(SESSIONS, '  演示  ').map((s) => s.id)).toEqual(['3']);
  });

  it('无匹配返回空数组', () => {
    expect(filterSessions(SESSIONS, '不存在的标题')).toEqual([]);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/session-filter.test.ts`

Expected: FAIL，`session-filter` 模块不存在。

- [ ] **Step 7: 实现 `filterSessions`**

创建 `apps/web/src/lib/session-filter.ts`：

```ts
import type { SessionSummary } from '@ai-office/shared';

/** 侧栏会话搜索：标题子串、大小写不敏感；空关键字直接返回原数组。 */
export function filterSessions(
  sessions: SessionSummary[],
  query: string,
): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
}
```

- [ ] **Step 8: 运行全部 Web 测试**

Run: `pnpm --filter @ai-office/web test`

Expected: 全部 PASS（新增 10 个用例 + 原有用例）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/lib/format.ts apps/web/src/lib/format.test.ts apps/web/src/lib/session-filter.ts apps/web/src/lib/session-filter.test.ts
git commit -m "feat(web): 新增会话相对时间与标题筛选工具函数"
```

---

### Task 2: 登录态持久化邮箱

**Files:**
- Modify: `packages/web-core/src/auth.ts`
- Create: `packages/web-core/src/auth.test.ts`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/web-core/src/auth.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getEmail, getRole, getToken } from './auth';

function createStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('登录态存储', () => {
  it('clearToken 同时清除 token / role / email', () => {
    window.localStorage.setItem('ai_office_token', 't');
    window.localStorage.setItem('ai_office_role', 'admin');
    window.localStorage.setItem('ai_office_email', 'demo@example.com');

    clearToken();

    expect(getToken()).toBeNull();
    expect(getRole()).toBeNull();
    expect(getEmail()).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/web-core test -- src/auth.test.ts`

Expected: FAIL，`getEmail` 未导出。

- [ ] **Step 3: 实现邮箱持久化**

修改 `packages/web-core/src/auth.ts`：

在 `const ROLE_KEY = 'ai_office_role';` 下方新增：

```ts
const EMAIL_KEY = 'ai_office_email';
```

在 `getRole` 下方新增：

```ts
export function getEmail(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(EMAIL_KEY);
}

function setEmail(email: string): void {
  window.localStorage.setItem(EMAIL_KEY, email);
}
```

把 `clearToken` 改为：

```ts
export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ROLE_KEY);
  window.localStorage.removeItem(EMAIL_KEY);
}
```

在 `register` 与 `login` 的 `setRole(data.user.role);` 下方各补一行：

```ts
  setEmail(data.user.email);
```

- [ ] **Step 4: 在 Web 端 re-export**

修改 `apps/web/src/lib/api.ts` 的 re-export 列表，在 `getRole,` 下方加一行：

```ts
  getEmail,
```

- [ ] **Step 5: 运行测试与类型检查**

Run:

```bash
pnpm --filter @ai-office/web-core test
pnpm --filter @ai-office/web exec tsc --noEmit -p tsconfig.json
```

Expected: web-core 测试 PASS；tsc 无输出（0 错误）。

- [ ] **Step 6: 提交**

```bash
git add packages/web-core/src/auth.ts packages/web-core/src/auth.test.ts apps/web/src/lib/api.ts
git commit -m "feat(auth): 登录态持久化邮箱供侧栏用户区展示"
```

---

### Task 3: 新增图标

**Files:**
- Modify: `apps/web/src/components/icons.tsx`

- [ ] **Step 1: 在文件末尾追加 5 个图标**

在 `IconWallet` 之后追加：

```tsx
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  );
}

export function IconSidebar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Svg>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </Svg>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @ai-office/web exec tsc --noEmit -p tsconfig.json`

Expected: 0 错误。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/icons.tsx
git commit -m "feat(web): 补充侧栏搜索、折叠、复制等图标"
```

---

### Task 4: 成果抽屉组件与样式

**Files:**
- Create: `apps/web/src/components/artifact-drawer.tsx`
- Modify: `packages/web-core/src/globals.css`

- [ ] **Step 1: 创建组件**

创建 `apps/web/src/components/artifact-drawer.tsx`：

```tsx
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
```

- [ ] **Step 2: 追加抽屉样式**

在 `packages/web-core/src/globals.css` 末尾追加：

```css
/* ============================ 工作台成果抽屉 ============================ */

.wb-drawer-layer {
  position: fixed;
  inset: 0;
  z-index: 40;
  visibility: hidden;
  pointer-events: none;
}

.wb-drawer-layer.open {
  visibility: visible;
  pointer-events: auto;
}

.wb-drawer-backdrop {
  position: absolute;
  inset: 0;
  background: transparent;
}

.wb-drawer {
  position: absolute;
  top: 16px;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  width: 360px;
  background: #fff;
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  box-shadow: var(--shadow-2);
  opacity: 0;
  transform: translateX(12px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.wb-drawer-layer.open .wb-drawer {
  opacity: 1;
  transform: none;
}

.wb-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--wb-line);
}

.wb-drawer-title {
  font-size: 15px;
  font-weight: 650;
  color: var(--wb-ink);
}

.wb-drawer-sub {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.wb-drawer-body {
  flex: 1;
  min-height: 0;
  padding: 14px;
  overflow-y: auto;
}

.wb-drawer-empty {
  padding: 24px 16px;
  font-size: 12.5px;
  color: var(--wb-ink-3);
  text-align: center;
  border: 1px dashed var(--wb-line-strong);
  border-radius: 12px;
}

.wb-artifact-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wb-artifact-card {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  background: #fff;
  border: 1px solid var(--wb-line);
  border-radius: 12px;
}

.wb-artifact-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 34px;
  height: 34px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  border-radius: 9px;
  background: #6b6b6b;
}

.wb-artifact-icon.docx {
  background: #2f6fed;
}

.wb-artifact-icon.xlsx {
  background: #1f9d55;
}

.wb-artifact-icon.pptx {
  background: #e06a2b;
}

.wb-artifact-main {
  flex: 1;
  min-width: 0;
}

.wb-artifact-name {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-all;
  color: var(--wb-ink);
}

.wb-artifact-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--wb-ink-3);
}

.wb-download {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  padding: 4px 9px;
  font-size: 12px;
  color: var(--wb-ink);
  background: #fff;
  border: 1px solid var(--wb-line-strong);
  border-radius: 8px;
  cursor: pointer;
}

.wb-download:hover {
  background: var(--wb-hover);
}

@media (max-width: 760px) {
  .wb-drawer-backdrop {
    background: rgba(0, 0, 0, 0.24);
  }

  .wb-drawer {
    top: 12px;
    right: 12px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wb-drawer {
    transition: none;
  }
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @ai-office/web exec tsc --noEmit -p tsconfig.json`

Expected: 0 错误。若 `inert` 报类型错误，改为：

```tsx
{...(open ? {} : { inert: '' })}
```

并保留 `aria-hidden={!open}`。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/artifact-drawer.tsx packages/web-core/src/globals.css
git commit -m "feat(web): 新增成果右侧抽屉组件与样式"
```

---

### Task 5: 侧栏改版

**Files:**
- Modify: `apps/web/src/components/app-shell.tsx`
- Modify: `packages/web-core/src/globals.css`

- [ ] **Step 1: 重写 `app-shell.tsx`**

用以下内容整体替换 `apps/web/src/components/app-shell.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { SessionSummary } from '@ai-office/shared';
import { clearToken, getEmail, getRole } from '../lib/api';
import { relativeTime } from '../lib/format';
import { filterSessions } from '../lib/session-filter';
import {
  IconBook,
  IconChat,
  IconGrid,
  IconLogout,
  IconPlug,
  IconPlus,
  IconSearch,
  IconSidebar,
  IconSpark,
  IconWallet,
} from './icons';

type ActiveNav = 'workbench' | 'kb' | 'connectors' | 'billing';

// 运营端是独立应用（通常部署在内网），这里只放外链；未配置时对管理员也不显示。
// 构建期内联：生产镜像需要在构建时传入 NEXT_PUBLIC_ADMIN_URL。
const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:3001' : '');

interface AppShellProps {
  active: ActiveNav;
  children: ReactNode;
  sessions?: SessionSummary[];
  sessionId?: string;
  onSelectSession?: (id: string) => void;
  onNewSession?: () => void;
  sessionDisabled?: boolean;
}

const NAV: { key: ActiveNav; href: string; label: string; icon: typeof IconChat }[] = [
  { key: 'workbench', href: '/', label: '工作台', icon: IconChat },
  { key: 'kb', href: '/kb', label: '知识库', icon: IconBook },
  { key: 'connectors', href: '/connectors', label: '连接器', icon: IconPlug },
  { key: 'billing', href: '/billing', label: '套餐与用量', icon: IconWallet },
];

export function AppShell({
  active,
  children,
  sessions,
  sessionId,
  onSelectSession,
  onNewSession,
  sessionDisabled,
}: AppShellProps) {
  const router = useRouter();
  // 角色与邮箱只在挂载后读取：SSR 阶段没有 localStorage，渲染期读取会触发 hydration 不一致。
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRole(getRole() ?? '');
    setEmail(getEmail() ?? '');
  }, []);

  // 折叠状态挂载后读取，避免服务端渲染与水合结果不一致；
  // 没有手动选择时，窄屏默认收起，用户手动展开后以手动选择为准。
  useEffect(() => {
    const stored = window.localStorage.getItem('wb.sidebar.collapsed');
    if (stored === '1') setCollapsed(true);
    else if (stored === '0') setCollapsed(false);
    else if (window.matchMedia('(max-width: 960px)').matches) setCollapsed(true);
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const visibleSessions = useMemo(
    () => filterSessions(sessions ?? [], query),
    [sessions, query],
  );

  function persistCollapsed(next: boolean) {
    setCollapsed(next);
    window.localStorage.setItem('wb.sidebar.collapsed', next ? '1' : '0');
    if (next) {
      setSearchOpen(false);
      setQuery('');
    }
  }

  function toggleCollapsed() {
    persistCollapsed(!collapsed);
  }

  function toggleSearch() {
    // 窄屏自动收起时点击搜索，视为用户手动展开：显式落盘，优先于自动规则。
    if (collapsed) persistCollapsed(false);
    setSearchOpen((prev) => {
      const next = !prev;
      if (!next) setQuery('');
      return next;
    });
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setSearchOpen(false);
      setQuery('');
    }
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  const avatarLetter = email ? email[0].toUpperCase() : '?';

  return (
    <div className={`shell wb-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className={`sidebar wb-sidebar${collapsed ? ' collapsed' : ''}`} aria-label="侧栏">
        <div className="wb-side-head">
          <div className="wb-brand">
            <div className="wb-brand-mark">
              <IconSpark size={17} />
            </div>
            {!collapsed && <div className="wb-brand-name">AI 办公智能体</div>}
          </div>
          <div className="wb-side-tools">
            <button
              type="button"
              className="wb-icon-btn wb-collapse-btn"
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              title={collapsed ? '展开侧栏' : '收起侧栏'}
            >
              <IconSidebar size={16} />
            </button>
            <button
              type="button"
              className={`wb-icon-btn wb-search-btn${searchOpen ? ' active' : ''}`}
              onClick={toggleSearch}
              aria-label="搜索会话"
              aria-expanded={searchOpen}
              title="搜索会话"
            >
              <IconSearch size={16} />
            </button>
          </div>
        </div>

        {!collapsed && searchOpen && (
          <div className="wb-search">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="搜索最近任务"
              aria-label="搜索会话"
            />
          </div>
        )}

        {onNewSession ? (
          <button
            type="button"
            className="wb-new-task"
            onClick={onNewSession}
            disabled={sessionDisabled}
            aria-label="新建任务"
            title="新建任务"
          >
            <IconPlus size={16} />
            {!collapsed && <span>新建任务</span>}
          </button>
        ) : (
          <Link className="wb-new-task" href="/" aria-label="新建任务" title="新建任务">
            <IconPlus size={16} />
            {!collapsed && <span>新建任务</span>}
          </Link>
        )}

        <nav className="wb-nav" aria-label="主导航">
          {NAV.map(({ key, href, label, icon: Icon }) => (
            <Link
              key={key}
              href={href}
              className={`wb-nav-item${active === key ? ' active' : ''}`}
              aria-current={active === key ? 'page' : undefined}
              aria-label={label}
              title={label}
            >
              <Icon size={16} />
              {!collapsed && <span>{label}</span>}
            </Link>
          ))}
          {role === 'admin' && ADMIN_URL && (
            <a
              className="wb-nav-item"
              href={ADMIN_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="运营平台"
              title="运营平台"
            >
              <IconGrid size={16} />
              {!collapsed && <span>运营平台</span>}
            </a>
          )}
        </nav>

        {sessions !== undefined && !collapsed && (
          <div className="wb-recent">
            <div className="wb-recent-label">最近</div>
            <div className="wb-session-list">
              {visibleSessions.length === 0 ? (
                <div className="wb-side-empty">
                  {query ? '没有匹配的会话' : '暂无会话'}
                </div>
              ) : (
                visibleSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`wb-session${s.id === sessionId ? ' active' : ''}`}
                    onClick={() => onSelectSession?.(s.id)}
                    disabled={sessionDisabled}
                    title={s.title}
                  >
                    <span className="wb-session-title">{s.title}</span>
                    <span className="wb-session-time">{relativeTime(s.createdAt)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <div className="wb-user">
          <span className="wb-avatar" aria-hidden="true">
            {avatarLetter}
          </span>
          {!collapsed && (
            <div className="wb-user-main">
              <span className="wb-user-email" title={email || undefined}>
                {email || (role === 'admin' ? '管理员' : '成员')}
              </span>
              {email && <span className="wb-user-role">{role === 'admin' ? '管理员' : '成员'}</span>}
            </div>
          )}
          <button
            type="button"
            className="wb-icon-btn"
            onClick={logout}
            aria-label="退出登录"
            title="退出登录"
          >
            <IconLogout size={16} />
          </button>
        </div>
      </aside>
      <main className="main wb-main">{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: 追加侧栏样式**

在 `packages/web-core/src/globals.css` 末尾追加：

```css
/* ============================== 工作台外壳 ============================== */

.wb-shell {
  /* 不下载字体文件：系统装了 Inter 就用，否则按现有字体栈回落。 */
  font-family: Inter, var(--font);
  --wb-canvas: #ffffff;
  --wb-sidebar: #f2f2f2;
  --wb-ink: rgba(0, 0, 0, 0.9);
  --wb-ink-2: rgba(0, 0, 0, 0.55);
  --wb-ink-3: rgba(0, 0, 0, 0.38);
  --wb-line: rgba(0, 0, 0, 0.1);
  --wb-line-strong: rgba(0, 0, 0, 0.15);
  --wb-hover: #ebebeb;
  --wb-active: #e8e8e8;
  background: var(--wb-canvas);
}

.wb-main {
  background: var(--wb-canvas);
}

.wb-sidebar {
  flex: 0 0 272px;
  width: 272px;
  padding: 14px 12px;
  background: var(--wb-sidebar);
  border-right: 0;
}

.wb-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 14px;
}

.wb-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.wb-brand-mark {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 30px;
  height: 30px;
  color: #fff;
  background: linear-gradient(135deg, #00d69a, #00a878);
  border-radius: 9px;
}

.wb-brand-name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  color: var(--wb-ink);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wb-side-tools {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.wb-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--wb-ink-2);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.wb-icon-btn:hover,
.wb-icon-btn.active {
  color: var(--wb-ink);
  background: var(--wb-hover);
}

.wb-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 2px 10px;
  padding: 7px 9px;
  color: var(--wb-ink-3);
  background: #fff;
  border: 1px solid var(--wb-line);
  border-radius: 10px;
}

.wb-search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  font-size: 13px;
  color: var(--wb-ink);
  background: transparent;
  border: 0;
  outline: none;
}

.wb-new-task {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-ink);
  text-align: left;
  background: #fff;
  border: 1px solid var(--wb-line-strong);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.wb-new-task:hover:not(:disabled) {
  border-color: rgba(0, 0, 0, 0.28);
}

.wb-new-task:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wb-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wb-nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  font-size: 13.5px;
  color: var(--wb-ink-2);
  text-align: left;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.wb-nav-item svg {
  flex: 0 0 auto;
  opacity: 0.75;
}

.wb-nav-item:hover {
  color: var(--wb-ink);
  background: var(--wb-hover);
}

.wb-nav-item.active {
  font-weight: 600;
  color: var(--wb-ink);
  background: var(--wb-active);
}

.wb-nav-item.active svg {
  color: var(--mint-strong);
  opacity: 1;
}

.wb-recent {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-top: 16px;
}

.wb-recent-label {
  padding: 0 10px 6px;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.wb-session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.wb-session {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--wb-ink-2);
  text-align: left;
  background: none;
  border: 0;
  border-radius: 9px;
  cursor: pointer;
}

.wb-session:hover:not(:disabled) {
  color: var(--wb-ink);
  background: var(--wb-hover);
}

.wb-session.active {
  font-weight: 600;
  color: var(--wb-ink);
  background: var(--wb-active);
}

.wb-session:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wb-session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wb-session-time {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--wb-ink-3);
}

.wb-side-empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.wb-user {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-top: 12px;
  margin-top: auto;
}

.wb-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 30px;
  height: 30px;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #00d69a, #00a878);
  border-radius: 50%;
}

.wb-user-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

.wb-user-email {
  overflow: hidden;
  font-size: 12.5px;
  color: var(--wb-ink);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wb-user-role {
  font-size: 11px;
  color: var(--wb-ink-3);
}

.wb-shell.sidebar-collapsed .wb-sidebar {
  flex-basis: 64px;
  width: 64px;
  padding: 14px 10px;
}

.wb-shell.sidebar-collapsed .wb-side-head {
  flex-direction: column;
  gap: 8px;
  padding: 2px 0 14px;
}

.wb-shell.sidebar-collapsed .wb-side-tools {
  flex-direction: column;
}

.wb-shell.sidebar-collapsed .wb-nav-item,
.wb-shell.sidebar-collapsed .wb-new-task {
  justify-content: center;
  padding: 9px;
}

.wb-shell.sidebar-collapsed .wb-user {
  justify-content: center;
}

@media (max-width: 1100px) and (min-width: 961px) {
  .wb-sidebar {
    flex-basis: 248px;
    width: 248px;
  }
}

@media (max-width: 960px) and (min-width: 761px) {
  /* 窄屏默认由 JS 收起；用户手动展开后按 248px 渲染，手动选择优先。 */
  .wb-sidebar {
    flex-basis: 248px;
    width: 248px;
  }

  .wb-shell.sidebar-collapsed .wb-sidebar {
    flex-basis: 64px;
    width: 64px;
    padding: 14px 10px;
  }
}

@media (max-width: 760px) {
  .wb-shell {
    flex-direction: column;
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .wb-sidebar {
    flex-direction: row;
    flex-basis: auto;
    gap: 6px;
    align-items: center;
    width: 100%;
    height: auto;
    padding: 10px 12px;
    overflow-x: auto;
    border-bottom: 1px solid var(--wb-line);
  }

  .wb-shell.sidebar-collapsed .wb-sidebar {
    flex-basis: auto;
    width: 100%;
    padding: 10px 12px;
  }

  .wb-shell.sidebar-collapsed .wb-side-head {
    flex-direction: row;
    padding: 0;
  }

  .wb-shell.sidebar-collapsed .wb-side-tools {
    flex-direction: row;
  }

  .wb-side-head {
    flex: 0 0 auto;
    padding: 0;
  }

  .wb-brand-name,
  .wb-recent,
  .wb-user-main,
  .wb-search,
  .wb-search-btn,
  .wb-collapse-btn {
    display: none;
  }

  .wb-side-tools {
    display: none;
  }

  .wb-new-task {
    flex: 0 0 auto;
    width: auto;
    margin: 0;
  }

  .wb-nav {
    flex-direction: row;
    gap: 4px;
  }

  .wb-nav-item,
  .wb-new-task {
    padding: 8px 10px;
  }

  .wb-nav-item span,
  .wb-new-task span {
    display: none;
  }

  .wb-user {
    flex: 0 0 auto;
    padding: 0;
    margin: 0 0 0 auto;
  }

  .wb-main {
    height: auto;
    overflow: visible;
  }
}
```

- [ ] **Step 3: 类型检查与测试**

Run:

```bash
pnpm --filter @ai-office/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @ai-office/web test
```

Expected: tsc 0 错误；测试 PASS。

- [ ] **Step 4: 浏览器手工验证**

在当前开发服务器（`pnpm dev` 已在运行）打开 `http://localhost:3000`：

- 侧栏灰底、宽 272px；顶部折叠/搜索按钮可见。
- 点击搜索 → 输入框展开并聚焦；输入标题片段能实时过滤「最近」列表；Esc 关闭。
- 点击折叠 → 侧栏缩为 64px 图标栏；刷新后保持。
- 窄屏（≤960px）默认自动收起；点击搜索会手动展开，刷新后手动选择优先。
- 底部显示邮箱首字母头像、邮箱、角色与退出按钮。

Expected: 上述行为全部正常，无控制台报错。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/app-shell.tsx packages/web-core/src/globals.css
git commit -m "feat(web): 侧栏改为灰底可折叠并支持会话搜索"
```

---

### Task 6: 工作台页面改版

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `packages/web-core/src/globals.css`

- [ ] **Step 1: 重写 `page.tsx`**

用以下内容整体替换 `apps/web/src/app/page.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, ArtifactDto, SessionSummary } from '@ai-office/shared';
import { AppShell } from '../components/app-shell';
import { ArtifactDrawer } from '../components/artifact-drawer';
import {
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconFile,
  IconSend,
  IconSpark,
  IconTool,
  IconX,
} from '../components/icons';
import { errorText } from '@ai-office/web-core';
import { createSseParser } from '../lib/sse-parser';
import {
  confirmRun,
  createSession,
  downloadArtifact,
  getToken,
  isUnauthorized,
  listArtifacts,
  listSessions,
  streamTask,
} from '../lib/api';
import { currentConfirmCard } from '../lib/pending-confirm';
import { renderStep } from '../lib/render-step';

const SUGGESTIONS = [
  { label: '写一份周报', goal: '整理本周工作进展，生成一份周报文档' },
  { label: '调研竞品', goal: '调研竞品并给出结论' },
  { label: '做一张数据表', goal: '把项目数据整理成表格，包含汇总与趋势' },
  { label: '生成演示稿', goal: '根据项目方案生成一份演示稿' },
];

function EventRow({
  ev,
  onOpenArtifacts,
}: {
  ev: AgentEvent;
  onOpenArtifacts: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = renderStep(ev);
  if (!text) return null;

  let meta = '事件';
  let iconCls = 'tool';
  let icon = <IconTool size={15} />;

  if (ev.type === 'think') {
    meta = '思考';
    iconCls = 'think';
    icon = <IconSpark size={15} />;
  } else if (ev.type === 'tool_call') {
    meta = '工具调用';
    iconCls = 'tool';
    icon = <IconTool size={15} />;
  } else if (ev.type === 'tool_result') {
    meta = '工具结果';
    if (ev.payload.ok) {
      iconCls = 'tool';
      icon = <IconCheck size={15} />;
    } else {
      iconCls = 'result fail';
      icon = <IconX size={15} />;
    }
  } else if (ev.type === 'artifact') {
    meta = '文档产出';
    iconCls = 'artifact';
    icon = <IconFile size={15} />;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时保持静默，不打断对话流。
    }
  }

  return (
    <div className="wb-event">
      <div className={`wb-event-icon ${iconCls}`}>{icon}</div>
      <div className="wb-event-body">
        <div className="wb-event-meta">{meta}</div>
        <div className="wb-event-text">{text}</div>
        {ev.type === 'artifact' && (
          <button type="button" className="wb-event-action" onClick={onOpenArtifacts}>
            查看成果
            <IconArrowUpRight size={13} />
          </button>
        )}
      </div>
      <button
        type="button"
        className="wb-copy"
        onClick={() => void copy()}
        aria-label={copied ? '已复制' : '复制'}
        title={copied ? '已复制' : '复制'}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [goal, setGoal] = useState('');
  const [submittedGoal, setSubmittedGoal] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState('');
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
  }, [router]);

  async function refresh() {
    try {
      const list = await listSessions();
      setSessions(list);
      if (list.length) setSessionId(list[0].id);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function refreshArtifacts(sid: string) {
    if (!sid) {
      setArtifacts([]);
      return;
    }
    try {
      setArtifacts(await listArtifacts(sid));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  useEffect(() => {
    // 跑流期间不刷新：新会话在建流时会 setSessionId 触发本 effect，若并发拉取会覆盖乐观卡片；
    // 流结束后由 run() 的 finally 统一刷新，故这里等待 running 归位。
    if (running) return;
    void refreshArtifacts(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, running]);

  async function newSession(): Promise<SessionSummary> {
    const s = await createSession();
    setSessions((prev) => [s, ...prev]);
    setSessionId(s.id);
    return s;
  }

  function resetConversation() {
    setEvents([]);
    setSubmittedGoal('');
    setDecisions({});
    setError('');
  }

  function handleSelect(id: string) {
    if (running || id === sessionId) return;
    setSessionId(id);
    resetConversation();
  }

  async function handleNewSession() {
    try {
      await newSession();
      resetConversation();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function run() {
    setEvents([]);
    setSubmittedGoal(goal);
    setRunning(true);
    setError('');
    setDecisions({});
    let sid = sessionId;
    try {
      // sessionId 为 state，newSession 的 setSessionId 不会同步更新本次渲染闭包里的值，
      // 故必须用 newSession 返回的 id 直接发起请求，否则会 POST 到空 id 的会话。
      if (!sid) sid = (await newSession()).id;
      const res = await streamTask(sid, goal);
      if (!res.ok) {
        // 错误响应通常带 JSON body 但没有 SSE 帧；不在此拦截就会静默结束、既不报错也无事件。
        const detail = await res.text().catch(() => '');
        throw new Error(`stream_failed_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parse(decoder.decode(value, { stream: true }))) {
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            setRunId(ev.runId);
            setEvents((prev) => [...prev, ev]);
            if (ev.type === 'artifact') {
              setArtifacts((prev) => [
                {
                  id: '',
                  kind: String(ev.payload.kind ?? 'docx') as ArtifactDto['kind'],
                  filename: String(ev.payload.filename ?? ''),
                  size: Number(ev.payload.size ?? 0),
                  version: 0,
                  createdAt: new Date().toISOString(),
                },
                ...prev,
              ]);
            }
          }
          if (m.event === 'error') {
            const d = m.data as { message?: unknown } | null;
            setError(d && typeof d.message === 'string' ? d.message : JSON.stringify(m.data));
          }
        }
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      setRunning(false);
      void refreshArtifacts(sid);
    }
  }

  async function decide(confirmId: string, approved: boolean) {
    // 立即禁用按钮（在 tool_result 回来之前给出反馈）；随后由事件流自然收尾。
    setDecisions((prev) => ({ ...prev, [confirmId]: approved }));
    try {
      await confirmRun(runId, confirmId, approved);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      // 决策未送达（网络/上游故障）：撤销乐观禁用，否则按钮会一直卡在
      // 「已允许/已拒绝」直到闸门超时，用户无法重试。
      setDecisions((prev) => {
        const next = { ...prev };
        delete next[confirmId];
        return next;
      });
      setError(errorText(err));
    }
  }

  const current = sessions.find((s) => s.id === sessionId);
  const inConversation = running || events.length > 0 || submittedGoal !== '';
  const confirmCard = currentConfirmCard(events);

  const composer = (
    <div className="wb-composer-wrap">
      <div className="wb-composer">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running && goal.trim()) void run();
            }
          }}
          placeholder="今天帮你做些什么？写下目标，智能体会规划并执行…"
          rows={2}
          disabled={running}
          aria-label="任务目标"
        />
        <div className="wb-composer-foot">
          <span className="wb-composer-hint">Enter 发送 · Shift + Enter 换行</span>
          <div className="spacer" />
          <button
            type="button"
            className="wb-send"
            onClick={() => void run()}
            disabled={running || !goal.trim()}
            aria-label="开始执行"
            title="开始执行"
          >
            <IconSend size={17} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <AppShell
      active="workbench"
      sessions={sessions}
      sessionId={sessionId}
      onSelectSession={handleSelect}
      onNewSession={() => void handleNewSession()}
      sessionDisabled={running}
    >
      <div className="wb-topbar">
        <span className="wb-topbar-title">{current?.title ?? '新任务'}</span>
        <div className="wb-topbar-actions">
          <button
            type="button"
            className={`wb-icon-btn wb-drawer-trigger${drawerOpen ? ' active' : ''}`}
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="成果"
            aria-expanded={drawerOpen}
            title="成果"
          >
            <IconFile size={17} />
            {artifacts.length > 0 && <span className="wb-badge">{artifacts.length}</span>}
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error wb-banner" role="alert">
          {error}
        </div>
      )}

      <div className="wb-workbench">
        {inConversation ? (
          <div className="wb-conv">
            <div className="wb-conv-scroll">
              <div className="wb-thread">
                {submittedGoal && (
                  <div className="wb-user-msg">
                    <div className="wb-user-text">{submittedGoal}</div>
                  </div>
                )}
                {events.map((ev) => (
                  <EventRow
                    key={ev.seq}
                    ev={ev}
                    onOpenArtifacts={() => setDrawerOpen(true)}
                  />
                ))}
                {running && (
                  <div className="wb-running">
                    <span className="wb-spinner" />
                    智能体执行中…
                  </div>
                )}
              </div>

              {confirmCard &&
                (() => {
                  const decided = decisions[confirmCard.confirmId];
                  return (
                    <div className="wb-confirm">
                      <div className="wb-confirm-title">需要确认：{confirmCard.tool}</div>
                      <div className="wb-confirm-sub">该工具会访问外部资源，请确认后再执行。</div>
                      <pre className="wb-confirm-args">{JSON.stringify(confirmCard.args, null, 2)}</pre>
                      {decided === undefined ? (
                        <div className="wb-confirm-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => void decide(confirmCard.confirmId, true)}
                          >
                            允许执行
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void decide(confirmCard.confirmId, false)}
                          >
                            拒绝
                          </button>
                        </div>
                      ) : (
                        <span className="wb-confirm-done">
                          <IconCheck size={14} />
                          {decided ? '已允许' : '已拒绝'}（等待执行结果…）
                        </span>
                      )}
                    </div>
                  );
                })()}
            </div>
            <div className="wb-composer-dock">
              {composer}
              <p className="wb-disclaimer">内容由 AI 生成，请核实重要信息。</p>
            </div>
          </div>
        ) : (
          <div className="wb-hero">
            <h1 className="wb-hero-title">
              AI 办公智能体，<em>我帮你</em>
            </h1>
            <p className="wb-hero-sub">把目标交给智能体：它会调研、写文档、做表格、生成演示稿。</p>
            {composer}
            <div className="wb-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="wb-suggestion"
                  onClick={() => setGoal(s.goal)}
                >
                  <span>{s.label}</span>
                  <IconArrowUpRight size={15} />
                </button>
              ))}
            </div>
            <p className="wb-disclaimer">内容由 AI 生成，请核实重要信息。</p>
          </div>
        )}

        <ArtifactDrawer
          open={drawerOpen}
          artifacts={artifacts}
          onClose={() => setDrawerOpen(false)}
          onDownload={(a) =>
            void downloadArtifact(a.id, a.filename).catch((e) => setError(errorText(e)))
          }
        />
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 2: 追加工作台样式**

在 `packages/web-core/src/globals.css` 末尾追加：

```css
/* ============================== 工作台页面 ============================== */

.wb-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 32px 8px;
}

.wb-topbar-title {
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-ink);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wb-topbar-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.wb-drawer-trigger {
  position: relative;
}

.wb-badge {
  position: absolute;
  top: 1px;
  right: 1px;
  display: grid;
  place-items: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: #1a1a1a;
  border-radius: 999px;
}

.wb-banner {
  margin: 0 32px 10px;
}

.wb-workbench {
  display: flex;
  flex: 1;
  min-height: 0;
}

.wb-conv {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.wb-conv-scroll {
  flex: 1;
  min-height: 0;
  padding: 8px 32px 20px;
  overflow-y: auto;
}

.wb-thread {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 904px;
  padding-top: 10px;
  margin: 0 auto;
}

.wb-user-msg {
  display: flex;
  justify-content: flex-end;
}

.wb-user-text {
  max-width: 78%;
  padding: 12px 16px;
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--wb-ink);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--wb-sidebar);
  border-radius: 16px;
}

.wb-event {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 2px 0;
  animation: wb-rise 0.2s ease-out;
}

.wb-event-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--wb-ink-2);
  background: #f4f4f4;
  border-radius: 7px;
}

.wb-event-icon.think {
  color: #6d5bb8;
  background: #f3f1fd;
}

.wb-event-icon.tool {
  color: var(--mint-ink);
  background: var(--mint-soft);
}

.wb-event-icon.result.fail {
  color: var(--danger);
  background: var(--danger-soft);
}

.wb-event-icon.artifact {
  color: #a86908;
  background: #fff4e0;
}

.wb-event-body {
  flex: 1;
  min-width: 0;
}

.wb-event-meta {
  margin-bottom: 1px;
  font-size: 11px;
  color: var(--wb-ink-3);
}

.wb-event-text {
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--wb-ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.wb-event-action {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 9px;
  margin-top: 7px;
  font-size: 12px;
  color: var(--wb-ink);
  background: #fff;
  border: 1px solid var(--wb-line-strong);
  border-radius: 8px;
  cursor: pointer;
}

.wb-event-action:hover {
  background: var(--wb-hover);
}

.wb-copy {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--wb-ink-3);
  background: transparent;
  border: 0;
  border-radius: 7px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.wb-event:hover .wb-copy,
.wb-copy:focus-visible {
  opacity: 1;
}

.wb-copy:hover {
  color: var(--wb-ink);
  background: var(--wb-hover);
}

.wb-running {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--wb-ink-2);
}

.wb-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #d8d8d8;
  border-top-color: #1a1a1a;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.wb-confirm {
  width: 100%;
  max-width: 904px;
  padding: 16px 18px;
  margin: 14px auto 0;
  background: var(--amber-soft);
  border: 1px solid var(--amber-line);
  border-radius: 12px;
}

.wb-confirm-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--wb-ink);
}

.wb-confirm-sub {
  font-size: 12.5px;
  color: var(--amber-ink);
}

.wb-confirm-args {
  max-height: 180px;
  padding: 10px 12px;
  margin: 10px 0 12px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid #f1e2c2;
  border-radius: 10px;
}

.wb-confirm-actions {
  display: flex;
  gap: 8px;
}

.wb-confirm-done {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--amber-ink);
}

.wb-composer-dock {
  padding: 10px 32px 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0), #fff 22%);
}

.wb-composer-wrap {
  width: 100%;
  max-width: 936px;
  margin: 0 auto;
}

.wb-composer {
  padding: 12px 14px 10px;
  background: #fff;
  border: 1px solid var(--wb-line-strong);
  border-radius: 24px;
  box-shadow: 0 16px 32px -8px rgba(0, 0, 0, 0.06), 0 2px 4px -4px rgba(0, 0, 0, 0.1);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.wb-composer:focus-within {
  border-color: rgba(0, 0, 0, 0.28);
  box-shadow: 0 16px 32px -8px rgba(0, 0, 0, 0.08), 0 2px 4px -4px rgba(0, 0, 0, 0.12);
}

.wb-composer textarea {
  width: 100%;
  min-height: 64px;
  max-height: 200px;
  padding: 2px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--wb-ink);
  resize: none;
  background: transparent;
  border: 0;
  outline: none;
}

.wb-composer textarea::placeholder {
  color: var(--wb-ink-3);
}

.wb-composer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.wb-composer-hint {
  margin-left: 2px;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.wb-composer-foot .spacer {
  flex: 1;
}

.wb-send {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: #fff;
  background: #1a1a1a;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}

.wb-send:hover:not(:disabled) {
  background: #333;
}

.wb-send:active:not(:disabled) {
  transform: scale(0.96);
}

.wb-send:disabled {
  color: #a3a3a3;
  background: #e3e3e3;
  cursor: not-allowed;
}

.wb-disclaimer {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--wb-ink-3);
  text-align: center;
}

.wb-hero {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 32px 40px;
  overflow-y: auto;
}

.wb-hero-title {
  margin-bottom: 10px;
  font-size: clamp(32px, 4vw, 44px);
  font-weight: 750;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: var(--wb-ink);
  text-align: center;
}

.wb-hero-title em {
  font-style: normal;
  color: var(--mint-strong);
}

.wb-hero-sub {
  margin-bottom: 28px;
  font-size: 14px;
  color: var(--wb-ink-2);
  text-align: center;
}

.wb-suggestions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 936px;
  margin-top: 18px;
}

.wb-suggestion {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 16px;
  font-size: 13.5px;
  color: var(--wb-ink);
  text-align: left;
  background: #fff;
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.wb-suggestion:hover {
  background: #fafafa;
  border-color: var(--wb-line-strong);
}

.wb-suggestion svg {
  color: var(--wb-ink-3);
}

@keyframes wb-rise {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (max-width: 1100px) and (min-width: 961px) {
  .wb-conv-scroll,
  .wb-composer-dock,
  .wb-hero {
    padding-right: 24px;
    padding-left: 24px;
  }
}

@media (max-width: 760px) {
  .wb-topbar {
    padding: 12px 16px 6px;
  }

  .wb-banner {
    margin: 0 16px 10px;
  }

  .wb-conv-scroll,
  .wb-composer-dock,
  .wb-hero {
    padding-right: 16px;
    padding-left: 16px;
  }

  .wb-hero {
    padding-top: 40px;
    padding-bottom: 32px;
  }

  .wb-workbench {
    flex-direction: column;
    overflow-y: auto;
  }

  .wb-conv {
    flex: 0 0 auto;
    min-height: calc(100vh - 56px);
  }

  .wb-conv-scroll {
    overflow: visible;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wb-event {
    animation: none;
  }
}
```

- [ ] **Step 3: 类型检查与测试**

Run:

```bash
pnpm --filter @ai-office/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @ai-office/web test
```

Expected: tsc 0 错误；全部测试 PASS。

- [ ] **Step 4: 浏览器验证新任务页**

打开 `http://localhost:3000`（清空当前会话状态或点击「新建任务」）：

- 居中大标题「AI 办公智能体，我帮你」，其中「我帮你」为绿色。
- 输入框宽约 936px、圆角 24px、黑色圆形发送按钮。
- 4 个推荐卡片位于输入框下方；点击后填入输入框。
- 底部免责声明居中。

Expected: 与设计文档 §4 一致，控制台无报错。

- [ ] **Step 5: 浏览器验证会话页与抽屉**

发送一条目标（可用「写一份周报」）：

- 用户消息右对齐浅灰气泡；助手事件无卡片边框。
- 文档产出事件行带「查看成果」按钮，点击直接打开抽屉。
- 顶部右侧成果图标带数量角标；点击滑出抽屉；下载可用；Esc 关闭。
- 助手文本行 hover 出现复制按钮，点击后变对勾。

Expected: 与设计文档 §5、§7 一致；执行链路正常结束。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/app/page.tsx packages/web-core/src/globals.css
git commit -m "feat(web): 工作台改为 WorkBuddy 式布局与成果抽屉"
```

---

### Task 7: 全量校验

**Files:**
- 无新增；修复校验中发现的问题。

- [ ] **Step 1: 运行 Web 与共享包测试**

Run:

```bash
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web-core test
```

Expected: 全部 PASS。

- [ ] **Step 2: 生产构建**

Run: `pnpm --filter @ai-office/web build`

Expected: 构建成功，无 TypeScript / ESLint 错误。

- [ ] **Step 3: 运营端回归**

打开 `http://localhost:3001/login`，用 `demo@example.com / demo-password` 登录：

- 侧栏、表格、图表样式与改版前一致（未继承 `wb-` 样式）。
- 页面无横向滚动、无布局错位。

Expected: 运营端视觉无变化。

- [ ] **Step 4: 响应式检查**

在 1920 / 1280 / 1024 / 760 四种宽度下检查 `http://localhost:3000`：

- 无横向滚动条；侧栏在 ≤960px 默认收为 64px（手动展开优先）；≤760px 变为顶部栏。
- 抽屉在窄屏全宽并带遮罩，遮罩点击可关闭。

Expected: 四档宽度均正常。

- [ ] **Step 5: 最终提交（如有修复）**

```bash
git add -A
git commit -m "fix(web): 修正布局改版校验中发现的问题"
```

若 Step 1-4 无问题，跳过本步，不产生空提交。

---

## Self-Review

**Spec coverage：**

| 设计文档章节 | 对应任务 |
|---|---|
| §3 外壳与侧栏（尺寸、折叠、搜索、导航、最近、用户区） | Task 5 |
| §4 新任务页（标题、推荐卡片、声明） | Task 6 |
| §5 会话页（顶部栏、对话流、复制、确认卡片） | Task 6 |
| §6 输入框规格 | Task 6 |
| §7 成果抽屉（触发、布局、卡片、移动端、焦点） | Task 4 + Task 6 |
| §8 视觉 token | Task 4 + Task 5 + Task 6 |
| §9 响应式 | Task 5 + Task 6 |
| §10 改动文件 | 全部任务 |
| §11 测试与验收 | Task 1、2、7 |
| 相对时间纯函数 | Task 1 |
| 会话筛选纯函数 | Task 1 |
| 用户区邮箱来源 | Task 2 |
| 图标 | Task 3 |

**占位符扫描：** 无 TBD/TODO；所有代码步骤均给出完整实现或完整替换文件。

**类型一致性：** `relativeTime(iso, now?)`、`filterSessions(sessions, query)`、`getEmail()`、`ArtifactDrawer` 的 props、`wb-` 类名在各任务间一致。
