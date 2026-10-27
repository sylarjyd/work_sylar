# 跨会话并行运行与运行态跟踪 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台切换会话不再中断任务：后端在会话摘要回填当前运行，前端把单会话运行态改为按会话跟踪的多运行态，切回/刷新都能回放并接续。

**Architecture:** 后端 `SessionSummary` 增加 `activeRun`；前端新增无 React 依赖的 `RunTracker`，按 `sessionId` 保存事件、正文增量、决策与游标，页面只渲染当前会话条目；运行中的流在后台继续消费，刷新或跨标签页场景用 `activeRun` + `/api/runs/:id/stream?afterSeq=-1` 回放重挂。

**Tech Stack:** NestJS + Prisma（BFF）、Next.js 15 + React 19、Vitest、原生 fetch + SSE。

**Spec:** `docs/superpowers/specs/2026-10-27-multi-session-concurrent-runs-design.md`

**约定：**
- 直接在 `master` 开发，不开分支、不 push。
- 提交信息用中文 `type(scope): 摘要`，正文写「为什么」。
- 永不提交 `apps/bff/prisma/comments.sql` 与 `apps/bff/.vitest-report.json`；每次 `git add` 只列本任务涉及的文件。
- 所有文件操作使用绝对 Windows 路径。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `packages/shared/src/dto.ts` | 修改 | `SessionSummary.activeRun` 字段与 `ActiveRunSummary` 类型 |
| `apps/bff/src/sessions/sessions.service.ts` | 修改 | `list`/`detail` 批量回填活跃运行，失败降级为 `null` |
| `apps/bff/src/sessions/sessions.service.test.ts` | 修改 | 活跃运行回填、同会话优先、失败降级的单测 |
| `apps/bff/src/sessions/sessions.controller.test.ts` | 修改 | fake prisma 补 `run` 委托，避免列表/详情回填查询报错刷日志 |
| `apps/web/src/lib/session-filter.test.ts` | 修改 | 摘要 fixture 补 `activeRun: null` |
| `apps/web/src/lib/run-tracker.ts` | 新建 | 按会话保存运行态与事件折叠，纯 TS |
| `apps/web/src/lib/run-tracker.test.ts` | 新建 | 多会话互不串扰、增量/清空、状态、终态、清理 |
| `apps/web/src/app/page.tsx` | 修改 | 运行态迁移到 tracker，切换/挂回，去掉单会话守卫 |
| `apps/web/src/components/app-shell.tsx` | 修改 | 会话项运行/排队标记；移除 `sessionDisabled` |
| `packages/web-core/src/globals.css` | 修改 | 会话项状态点样式 |

不改动：执行器、队列、relay、记忆、问答缓存、`apps/web/src/lib/run-stream.ts`（tracker 直接复用它的事件回调契约）。

**实现备注（与设计稿的偏差）：** `Run.startedAt` 对 queued 行为 `null`，PostgreSQL `ORDER BY ... DESC` 会把 NULL 排在最前，`orderBy: startedAt desc` 对「同一会话多条」并不稳定。本计划改为在同一次 `findMany` 后按「running 优先，其次 queued」挑选，语义与「取当前活跃那条」一致且跨库确定。

---

### Task 1: 会话摘要回填当前运行（shared DTO + BFF）

**Files:**
- Modify: `D:\ws\ai\agent\work_sylar\packages\shared\src\dto.ts`
- Modify: `D:\ws\ai\agent\work_sylar\apps\bff\src\sessions\sessions.service.ts`
- Test: `D:\ws\ai\agent\work_sylar\apps\bff\src\sessions\sessions.service.test.ts`
- Test: `D:\ws\ai\agent\work_sylar\apps\bff\src\sessions\sessions.controller.test.ts`
- Modify: `D:\ws\ai\agent\work_sylar\apps\web\src\lib\session-filter.test.ts`

- [ ] **Step 1: 在 BFF 测试里补活跃运行的失败用例**

在 `apps/bff/src/sessions/sessions.service.test.ts` 的 `makeService` 增加两个参数（保持前 5 个参数位置不变）：

```ts
function makeService(
  models = ['m1', 'm2'],
  defaultModel: string | null = 'm1',
  assistants: AssistantFixture[] = [ASSISTANT],
  rows = all,
  busyTasks: { sessionId: string; status: string }[] = [],
  runs: { id: string; status: string; startedAt: Date | null; sessionId: string }[] = [],
  failActiveRuns = false,
) {
```

在 fake prisma 的 `task` 之后追加 `run` 委托：

```ts
    run: {
      findMany: async ({
        where,
      }: {
        where: { task: { sessionId: { in: string[] } }; status: { in: string[] } };
      }) => {
        if (failActiveRuns) throw new Error('db down');
        return runs
          .filter(
            (r) =>
              where.task.sessionId.in.includes(r.sessionId) &&
              where.status.in.includes(r.status),
          )
          .map((r) => ({ id: r.id, status: r.status, task: { sessionId: r.sessionId } }));
      },
    },
```

在该文件末尾追加新的 describe：

```ts
describe('SessionsService 运行标记', () => {
  const RUNS = [
    { id: 'r-queued', status: 'queued', startedAt: null, sessionId: 's1' },
    { id: 'r-running', status: 'running', startedAt: new Date('2026-01-03T00:00:00Z'), sessionId: 's1' },
    { id: 'r-other', status: 'queued', startedAt: null, sessionId: 's3' },
    { id: 'r-done', status: 'done', startedAt: new Date('2026-01-03T00:00:01Z'), sessionId: 's3' },
  ];

  it('list 按会话回填活跃运行，同一会话运行中优先', async () => {
    const { svc } = makeService(['m1'], 'm1', [ASSISTANT], all, [], RUNS);
    const page = await svc.list('t1', 'u1');
    expect(page.items.map((s) => [s.id, s.activeRun])).toEqual([
      ['s1', { id: 'r-running', status: 'running' }],
      ['s3', { id: 'r-other', status: 'queued' }],
    ]);
  });

  it('没有活跃运行时 activeRun 为 null', async () => {
    const page = await makeService().svc.list('t1', 'u1');
    expect(page.items.map((s) => s.activeRun)).toEqual([null, null]);
  });

  it('查询失败时降级为 null，列表与详情仍可用', async () => {
    const { svc } = makeService(['m1'], 'm1', [ASSISTANT], all, [], [], true);
    const page = await svc.list('t1', 'u1');
    expect(page.items.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(page.items.map((s) => s.activeRun)).toEqual([null, null]);
    expect((await svc.detail('s1', 't1', 'u1')).activeRun).toBeNull();
  });

  it('detail 回填活跃运行', async () => {
    const { svc } = makeService(['m1'], 'm1', [ASSISTANT], all, [], [
      { id: 'r5', status: 'running', startedAt: new Date(), sessionId: 's1' },
    ]);
    expect((await svc.detail('s1', 't1', 'u1')).activeRun).toEqual({
      id: 'r5',
      status: 'running',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/bff && pnpm exec vitest run src/sessions/sessions.service.test.ts`

Expected: FAIL —— `list` 返回的 `activeRun` 为 `undefined`（`toEqual` 断言失败），且 fake 里新加的 `run` 尚未被调用。

- [ ] **Step 3: 给 DTO 增加字段**

在 `packages/shared/src/dto.ts` 的 `SessionSummary` 之前插入：

```ts
/** 会话当前正在排队或执行的运行；侧栏据此显示运行标记。 */
export interface ActiveRunSummary {
  id: string;
  status: 'queued' | 'running';
}

export interface SessionSummary {
```

并在 `SessionSummary` 的 `pinned` 之后追加：

```ts
  /** 会话当前正在排队或执行的运行；无则为 null。 */
  activeRun: ActiveRunSummary | null;
```

- [ ] **Step 4: 在 SessionsService 回填 activeRun**

`apps/bff/src/sessions/sessions.service.ts`：

1. 引入 `Logger` 与类型：

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
```

```ts
  SESSION_PAGE_SIZE,
  type ActiveRunSummary,
  type AssistantPermissionMode,
```

2. 在类里加 logger：

```ts
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
```

3. `list()` 的末尾改为：

```ts
    const page = rows.slice(0, limit);
    const active = await this.activeRuns(page.map((s) => s.id));
    const items = page.map((s) => toSummary(s, active.get(s.id) ?? null));
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
```

4. `detail()` 的返回改为：

```ts
    if (!s) throw new NotFoundException('session_not_found');
    const active = await this.activeRuns([s.id]);
    return toSummary(s, active.get(s.id) ?? null);
```

5. 在 `messages()` 之后、类结束之前新增私有方法：

```ts
  /**
   * 批量查询会话当前活跃运行。失败降级为无标记：侧栏提示缺失不应让列表整体失败。
   * 同一会话理论上只会有一条（前端串行发送）；异常多条时运行中优先，其次排队中。
   */
  private async activeRuns(sessionIds: string[]): Promise<Map<string, ActiveRunSummary>> {
    const out = new Map<string, ActiveRunSummary>();
    if (sessionIds.length === 0) return out;
    try {
      const rows = await this.prisma.run.findMany({
        where: {
          task: { sessionId: { in: sessionIds } },
          status: { in: ['queued', 'running'] },
        },
        select: { id: true, status: true, task: { select: { sessionId: true } } },
      });
      for (const r of rows) {
        if (r.status !== 'queued' && r.status !== 'running') continue;
        const sid = r.task.sessionId;
        const seen = out.get(sid);
        if (seen && (seen.status === 'running' || r.status === 'queued')) continue;
        out.set(sid, { id: r.id, status: r.status });
      }
    } catch (err) {
      this.logger.warn(
        `activeRun query failed (sessions=${sessionIds.length}): ${(err as Error).message}`,
      );
    }
    return out;
  }
```

6. `toSummary` 签名与返回值：

```ts
function toSummary(
  s: {
    id: string;
    title: string;
    createdAt: Date;
    model: string | null;
    mode: string;
    assistantId?: string | null;
    assistant?: { name: string } | null;
    pinned?: boolean;
  },
  activeRun: ActiveRunSummary | null = null,
): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt.toISOString(),
    model: s.model ?? null,
    assistantId: s.assistantId ?? null,
    assistantName: s.assistant?.name ?? null,
    mode: isSessionMode(s.mode) ? s.mode : 'chat',
    pinned: s.pinned === true,
    activeRun,
  };
}
```

- [ ] **Step 4b: 补 web 的摘要 fixture**

`apps/web/src/lib/session-filter.test.ts` 三处 fixture 的 `pinned: false,` 后各加一行：

```ts
    activeRun: null,
```

- [ ] **Step 4c: 给控制器测试的 fake prisma 补 `run` 委托**

`apps/bff/src/sessions/sessions.controller.test.ts` 的 fake prisma 里，`task: { findFirst: ... },` 之后追加：

```ts
  run: {
    // 本文件只验证路由与鉴权，运行标记一律为空；缺这个委托会让 activeRun 查询抛错刷 warn。
    findMany: async () => [],
  },
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd apps/bff && pnpm exec vitest run src/sessions/sessions.service.test.ts
cd ../.. && pnpm --filter @ai-office/shared build
pnpm --filter @ai-office/bff typecheck
pnpm --filter @ai-office/web test
```

Expected: BFF 测试全绿；`tsc --noEmit` 无报错；web 既有测试（含 `session-filter.test.ts`）全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/dto.ts apps/bff/src/sessions/sessions.service.ts apps/bff/src/sessions/sessions.service.test.ts apps/bff/src/sessions/sessions.controller.test.ts apps/web/src/lib/session-filter.test.ts
git commit -m "$(cat <<'EOF'
feat(sessions): 会话摘要回填当前运行

前端需要在不打开会话的情况下知道它是否仍在跑，否则切走后就只能看落库历史。
列表/详情按页内会话 id 批量查询 queued/running 的 run，查询失败降级为无标记。
EOF
)"
```

---

### Task 2: 前端 RunTracker

**Files:**
- Create: `D:\ws\ai\agent\work_sylar\apps\web\src\lib\run-tracker.ts`
- Test: `D:\ws\ai\agent\work_sylar\apps\web\src\lib\run-tracker.test.ts`

- [ ] **Step 1: 先写失败测试**

创建 `apps/web/src/lib/run-tracker.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@ai-office/shared';
import { RunTracker } from './run-tracker';

function ev(
  seq: number,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
  runId = 'r1',
): AgentEvent {
  return { runId, seq, type, payload, ts: 1000 + seq } as AgentEvent;
}

function make() {
  const notify = vi.fn();
  return { tracker: new RunTracker(notify), notify };
}

describe('RunTracker', () => {
  it('两个会话的事件交替写入互不串扰', () => {
    const { tracker } = make();
    tracker.begin('s1', '问题一');
    tracker.begin('s2', '问题二');
    tracker.applyStep('s1', ev(0, 'think', { text: '甲' }, 'r1'));
    tracker.applyStep('s2', ev(0, 'think', { text: '乙' }, 'r2'));
    tracker.applyStep('s1', ev(1, 'tool_call', { tool: 'x', args: {} }, 'r1'));

    expect(tracker.snapshot('s1')?.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(tracker.snapshot('s2')?.events.map((e) => e.seq)).toEqual([0]);
    expect(tracker.snapshot('s1')?.runId).toBe('r1');
    expect(tracker.snapshot('s2')?.runId).toBe('r2');
    expect(tracker.snapshot('s1')?.goal).toBe('问题一');
  });

  it('assistant_delta 累加 liveText，think 到达时清空并接管事件', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.applyStep('s1', ev(0, 'assistant_delta', { text: '你好' }));
    tracker.applyStep('s1', ev(1, 'assistant_delta', { text: '世界' }));
    expect(tracker.snapshot('s1')?.liveText).toBe('你好世界');
    expect(tracker.snapshot('s1')?.events).toHaveLength(0);

    tracker.applyStep('s1', ev(2, 'think', { text: '你好世界' }));
    expect(tracker.snapshot('s1')?.liveText).toBe('');
    expect(tracker.snapshot('s1')?.events.map((e) => e.type)).toEqual(['think']);
  });

  it('status 更新排队位次，步骤到达后清除排队提示', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.applyStatus('s1', 'queued', 3);
    expect(tracker.snapshot('s1')).toMatchObject({ status: 'queued', queuePosition: 3 });

    tracker.applyStatus('s1', 'running', null);
    expect(tracker.snapshot('s1')).toMatchObject({ status: 'running', queuePosition: null });

    tracker.applyStatus('s1', 'canceled', null);
    tracker.applyTerminal('s1');
    tracker.applyDone('s1', 'done');
    expect(tracker.snapshot('s1')).toMatchObject({ terminal: true, finalStatus: 'canceled' });
  });

  it('终态后 terminal 为真，settle 可本地收尾', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.applyDone('s1', 'failed');
    expect(tracker.snapshot('s1')).toMatchObject({ terminal: true, finalStatus: 'failed' });

    tracker.begin('s2', 'q');
    tracker.settle('s2', 'failed');
    expect(tracker.snapshot('s2')).toMatchObject({ terminal: true, finalStatus: 'failed' });
  });

  it('clear 后 snapshot 为空且不再接收事件', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.clear('s1');
    tracker.applyStep('s1', ev(0, 'think', { text: 'x' }));
    expect(tracker.has('s1')).toBe(false);
    expect(tracker.snapshot('s1')).toBeNull();
  });

  it('attach 复用同一 runId 的内存条目，换 run 则重建', () => {
    const { tracker } = make();
    const st = tracker.begin('s1', 'q', [], 'r1');
    tracker.applyStep('s1', ev(0, 'think', { text: 'x' }));
    expect(tracker.attach('s1', 'r1', -1)).toBe(st);
    expect(tracker.snapshot('s1')?.events).toHaveLength(1);

    const st2 = tracker.attach('s1', 'r2', -1);
    expect(st2).not.toBe(st);
    expect(tracker.snapshot('s1')).toMatchObject({ runId: 'r2', events: [], terminal: false });
  });

  it('停止与决策状态按会话保存', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.markStopping('s1');
    expect(tracker.snapshot('s1')?.status).toBe('stopping');
    tracker.clearStopping('s1');
    expect(tracker.snapshot('s1')?.status).toBe('running');

    tracker.decide('s1', 'c1', true);
    expect(tracker.snapshot('s1')?.decisions).toEqual({ c1: true });
    tracker.undecide('s1', 'c1');
    expect(tracker.snapshot('s1')?.decisions).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && pnpm exec vitest run src/lib/run-tracker.test.ts`

Expected: FAIL —— `Cannot find module './run-tracker'`。

- [ ] **Step 3: 实现 RunTracker**

创建 `apps/web/src/lib/run-tracker.ts`：

```ts
import type {
  AgentEvent,
  AttachmentKind,
  RunStatus,
} from '@ai-office/shared';
import { createRunStreamState, type RunStreamState } from './run-stream';

/** 尚未终结时的视觉阶段；stopping 表示取消请求已发出、等终态帧。 */
export type RunPhase = 'queued' | 'running' | 'stopping';
export type FinalRunStatus = 'done' | 'failed' | 'canceled';

/** 本轮提交的附件；previewUrl 只在本页内存中用于即时预览。 */
export interface RunAttachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  previewUrl?: string;
}

export interface RunEntry {
  runId: string;
  status: RunPhase;
  queuePosition: number | null;
  /** 已消费的最大 step 序号，重连游标。 */
  lastSeq: number;
  events: AgentEvent[];
  /** 当前 think 的增量文本（未落库）。 */
  liveText: string;
  decisions: Record<string, boolean>;
  terminal: boolean;
  finalStatus: FinalRunStatus | null;
  /** 本轮提问与附件：切走再切回时仍能看到提问气泡。 */
  goal: string;
  attachments: RunAttachment[];
}

interface TrackedRun {
  stream: RunStreamState;
  entry: RunEntry;
}

/**
 * 按会话保存运行态：切走不丢、切回直接渲染。
 * 纯 TS、无 React 依赖；每次变更后调用 notify，由页面触发重渲染。
 */
export class RunTracker {
  private readonly runs = new Map<string, TrackedRun>();

  constructor(private readonly notify: () => void) {}

  /** 新起一轮：覆盖该会话旧条目，返回可交给 consumeRunStream 的流状态。 */
  begin(
    sessionId: string,
    goal: string,
    attachments: RunAttachment[] = [],
    runId = '',
  ): RunStreamState {
    const stream = createRunStreamState();
    stream.runId = runId;
    this.runs.set(sessionId, {
      stream,
      entry: {
        runId,
        // 新建 run 落库即 queued，先按排队展示，首个步骤或状态帧再切执行中。
        status: 'queued',
        queuePosition: null,
        lastSeq: -1,
        events: [],
        liveText: '',
        decisions: {},
        terminal: false,
        finalStatus: null,
        goal,
        attachments,
      },
    });
    this.notify();
    return stream;
  }

  /**
   * 挂回一条已存在的运行：内存里同 runId 的条目原样沿用（切走再切回），
   * 否则按 afterSeq 新建条目，由调用方从头回放。
   */
  attach(sessionId: string, runId: string, afterSeq = -1): RunStreamState {
    const existing = this.runs.get(sessionId);
    if (existing && existing.stream.runId === runId) return existing.stream;
    const stream = createRunStreamState();
    stream.runId = runId;
    stream.lastSeq = afterSeq;
    this.runs.set(sessionId, {
      stream,
      entry: {
        runId,
        status: 'running',
        queuePosition: null,
        lastSeq: afterSeq,
        events: [],
        liveText: '',
        decisions: {},
        terminal: false,
        finalStatus: null,
        goal: '',
        attachments: [],
      },
    });
    this.notify();
    return stream;
  }

  applyStep(sessionId: string, ev: AgentEvent): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    const { entry } = run;
    if (typeof ev.runId === 'string' && ev.runId) entry.runId = ev.runId;
    if (typeof ev.seq === 'number') entry.lastSeq = Math.max(entry.lastSeq, ev.seq);
    // 收到步骤说明已经开始执行，清掉排队提示。
    if (entry.status === 'queued') entry.status = 'running';
    entry.queuePosition = null;
    if (ev.type === 'assistant_delta') {
      // 增量只喂给实时气泡；完整 think 到达时会用全文替换，避免两处重复。
      const text = typeof ev.payload.text === 'string' ? ev.payload.text : '';
      if (text) entry.liveText += text;
      this.notify();
      return;
    }
    if (ev.type === 'think') entry.liveText = '';
    entry.events.push(ev);
    this.notify();
  }

  applyStatus(sessionId: string, status: RunStatus, position: number | null): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    const { entry } = run;
    if (status === 'queued') {
      entry.status = 'queued';
      entry.queuePosition = position;
    } else if (status === 'running') {
      // 取消请求已发出时保持 stopping，等终态帧收尾。
      if (entry.status !== 'stopping') entry.status = 'running';
      entry.queuePosition = null;
    } else {
      // done/failed/canceled 只记录终态，收尾由 applyTerminal 统一处理。
      entry.finalStatus = status;
    }
    this.notify();
  }

  applyDone(sessionId: string, status: RunStatus): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    if (!run.entry.finalStatus) {
      run.entry.finalStatus =
        status === 'canceled' || status === 'failed' ? status : 'done';
    }
    run.entry.terminal = true;
    run.entry.liveText = '';
    this.notify();
  }

  applyError(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.entry.finalStatus = run.entry.finalStatus ?? 'failed';
    run.entry.terminal = true;
    run.entry.liveText = '';
    this.notify();
  }

  applyTerminal(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.entry.terminal = true;
    run.entry.finalStatus = run.entry.finalStatus ?? 'done';
    if (run.entry.status === 'stopping') run.entry.status = 'running';
    run.entry.liveText = '';
    this.notify();
  }

  /** 流彻底失联时本地收尾，避免输入框永久只读。 */
  settle(sessionId: string, status: FinalRunStatus = 'failed'): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    run.entry.terminal = true;
    run.entry.finalStatus = status;
    run.entry.liveText = '';
    this.notify();
  }

  markStopping(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    run.entry.status = 'stopping';
    this.notify();
  }

  clearStopping(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal || run.entry.status !== 'stopping') return;
    run.entry.status = 'running';
    this.notify();
  }

  decide(sessionId: string, confirmId: string, approved: boolean): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.entry.decisions = { ...run.entry.decisions, [confirmId]: approved };
    this.notify();
  }

  undecide(sessionId: string, confirmId: string): void {
    const run = this.runs.get(sessionId);
    if (!run || !(confirmId in run.entry.decisions)) return;
    const next = { ...run.entry.decisions };
    delete next[confirmId];
    run.entry.decisions = next;
    this.notify();
  }

  has(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  clear(sessionId: string): void {
    if (this.runs.delete(sessionId)) this.notify();
  }

  snapshot(sessionId: string): RunEntry | null {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    return {
      ...run.entry,
      events: run.entry.events.slice(),
      decisions: { ...run.entry.decisions },
      attachments: run.entry.attachments.slice(),
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd apps/web && pnpm exec vitest run src/lib/run-tracker.test.ts src/lib/run-stream.test.ts
```

Expected: 两个文件全绿（`run-stream.test.ts` 未改动，用于确认回调契约没被破坏）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/run-tracker.ts apps/web/src/lib/run-tracker.test.ts
git commit -m "$(cat <<'EOF'
feat(web): 新增按会话跟踪的运行态表

运行态原来挂在页面单例上，切走就丢。把事件折叠、增量正文、决策与游标收进
纯 TS 的 RunTracker，按 sessionId 隔离，供页面在后台继续消费并在切回时渲染。
EOF
)"
```

---

### Task 3: 工作台运行态迁移到 tracker

本任务没有页面级单测，以 `tsc --noEmit` + 既有 vitest 为准；每个 Step 结束不要求可编译，Task 结束必须全绿。

**Files:**
- Modify: `D:\ws\ai\agent\work_sylar\apps\web\src\app\page.tsx`

- [ ] **Step 1: 换导入**

把：

```ts
import {
  consumeRunStream,
  createRunStreamState,
  type RunStreamHandlers,
} from '../lib/run-stream';
```

改为：

```ts
import { consumeRunStream, type RunStreamHandlers } from '../lib/run-stream';
import { RunTracker, type RunAttachment } from '../lib/run-tracker';
```

把 `type AttachmentRef,` 从 `@ai-office/shared` 的导入里删掉（不再有 `SubmittedAttachment`）。

- [ ] **Step 2: 删除 `SubmittedAttachment`，加模块级空值常量**

删掉：

```ts
/** 已提交消息的附件；previewUrl 仅供本次会话内即时预览，刷新后不再保留。 */
interface SubmittedAttachment extends AttachmentRef {
  previewUrl?: string;
}
```

在 `HERO_SUB` 常量之后加：

```ts
/** 无条目时的稳定空值，避免每次渲染新建引用。 */
const NO_EVENTS: AgentEvent[] = [];
const NO_ATTACHMENTS: RunAttachment[] = [];
const NO_DECISIONS: Record<string, boolean> = {};
```

- [ ] **Step 3: 改状态块并派生当前会话视图**

把这段：

```ts
  const [goal, setGoal] = useState('');
  const [submittedGoal, setSubmittedGoal] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  // 正在流式输出的正文：由 assistant_delta 逐块累加，收到完整 think 后清空并由它接管。
  const [liveText, setLiveText] = useState('');
```

改为：

```ts
  const [goal, setGoal] = useState('');
```

把：

```ts
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
```

改为：

```ts
  const [error, setError] = useState('');
  // 运行态按会话存放在纯 TS 表里：切走不中断，切回直接渲染该会话条目。
  const [, bumpTrackerVersion] = useState(0);
  const trackerRef = useRef<RunTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new RunTracker(() => bumpTrackerVersion((v) => v + 1));
  }
  const tracker = trackerRef.current;
  // 同一会话同一时刻最多一条被消费的流：起跑与回放挂回都先占位。
  const streamingRef = useRef(new Set<string>());
  // 事件回调可能在用户切走之后才到达：用它判断「当前查看的会话」，避免给别的会话刷新页面级视图。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
```

删掉 `const [submittedAttachments, setSubmittedAttachments] = useState<SubmittedAttachment[]>([]);`。

删掉：

```ts
  // 重连游标：seq 从 0 开始，未收到任何 step 时用 -1 从头回放。
  const lastSeqRef = useRef(-1);
```

在 `pendingRef.current = pendingAttachments;` 之后加：

```ts
  // 当前会话视图：由 tracker 快照派生，事件/正文/决策都跟着会话走。
  const view = sessionId ? tracker.snapshot(sessionId) : null;
  const events = view?.events ?? NO_EVENTS;
  const liveText = view?.liveText ?? '';
  const decisions = view?.decisions ?? NO_DECISIONS;
  const submittedGoal = view?.goal ?? '';
  const submittedAttachments = view?.attachments ?? NO_ATTACHMENTS;
  const queuePosition = view?.queuePosition ?? null;
  const stopping = !!view && !view.terminal && view.status === 'stopping';
  const runId = view?.runId ?? '';
  const running = !!view && !view.terminal;
  // 视觉阶段映射回 RunStatus：终结后用于展示「已取消」等收尾文案。
  const runStatus: RunStatus | null = view
    ? view.terminal
      ? view.finalStatus
      : view.status === 'queued'
        ? 'queued'
        : 'running'
    : null;
  // prepare 已把本轮提问落库：刷新或切回后历史里也有同一条，同一份提问只渲染一次（优先历史）。
  const lastHistoryMsg = history[history.length - 1];
  const pendingEchoed =
    !!view &&
    !view.terminal &&
    submittedGoal !== '' &&
    lastHistoryMsg?.role === 'user' &&
    lastHistoryMsg.content === submittedGoal;
  const showPendingTurn = !!view && !pendingEchoed;
```

- [ ] **Step 4: 改写清理函数**

把 `resetConversation` 与 `clearLiveTurn` 两个函数整体替换为：

```ts
  function resetConversation() {
    setHistory([]);
    historyReqRef.current += 1;
    loadedHistoryRef.current = '';
    setError('');
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setArtifacts([]);
    discardPending();
  }

  /** 释放并清除某会话的内存条目；终态条目由落库历史接管时使用。 */
  function releaseEntry(id: string) {
    const entry = tracker.snapshot(id);
    if (entry) {
      for (const a of entry.attachments) if (a.previewUrl) releaseUrl(a.previewUrl);
    }
    tracker.clear(id);
  }

  /** 只丢弃已终结的条目：运行中的条目保留，后台流继续消费。 */
  function dropFinishedEntry(id: string) {
    const entry = tracker.snapshot(id);
    if (!entry?.terminal) return;
    releaseEntry(id);
  }

  /**
   * done 之后把实时条目交回落库历史：执行器在发布终态之前已写好 assistant 消息，
   * 因此这里拉到的历史是完整的。不交接的话，下一次发送覆盖条目时上一轮答案会从界面消失。
   * 拉取失败则保留实时条目，回答已经上屏，不应凭空消失。
   */
  async function settleIntoTimeline(id: string) {
    if (id !== sessionIdRef.current) return;
    const req = ++historyReqRef.current;
    try {
      const list = await listSessionMessages(id);
      if (req !== historyReqRef.current || id !== sessionIdRef.current) return;
      loadedHistoryRef.current = id;
      setHistory(list);
      stickToBottomRef.current = true;
      releaseEntry(id);
    } catch {
      // 拉取失败保持实时视图。
    }
  }
```

同时删除 `discardSubmitted()` 函数（其唯一调用方已随 `submittedAttachments` 状态移除）。

- [ ] **Step 5: `handleSelect` 保持不可切换，但改用 tracker 清理**

把整个 `handleSelect` 换成（本任务仍保留运行中不可切换，Task 4 再放开）：

```ts
  function handleSelect(id: string) {
    if (running) return;
    const needLoad = loadedHistoryRef.current !== id;
    if (id !== sessionId) {
      const target = sessions.find((s) => s.id === id);
      // 历史会话没有固化的模型：展示当前默认模型，实际运行由服务端按默认值解析。
      setSelectedModel(target?.model ?? defaultModel);
      setSessionId(id);
      resetConversation();
    } else if (needLoad) {
      // 同一会话回看：落库历史接管已结束的那一轮，避免同一轮展示两次。
      dropFinishedEntry(id);
    }
    if (needLoad) void loadHistory(id);
  }
```

`handleNewSession` 与 `handleDeleteSession` 保持原样（后者稍后补一条清理）。

- [ ] **Step 6: 重写 `run()` 并新增流处理工厂**

把 `async function run()` 整体替换为：

```ts
  /**
   * 流事件统一走 tracker：初连、重连、挂回共用同一套处理，页面只有一份折叠逻辑。
   */
  function makeHandlers(id: string): RunStreamHandlers {
    return {
      onStep(ev) {
        tracker.applyStep(id, ev);
        if (ev.type === 'artifact') addOptimisticArtifact(ev);
        syncRunMarker(id);
      },
      onStatus(status, position) {
        tracker.applyStatus(id, status, position);
        syncRunMarker(id);
      },
      onDone(status) {
        tracker.applyDone(id, status);
      },
      onError(message) {
        setError(message);
        tracker.applyError(id);
      },
      onTerminal() {
        tracker.applyTerminal(id);
        syncRunMarker(id);
        // 自动命名按会话 id 更新侧栏，后台会话结束也要补。
        void syncSessionTitle(id);
        // 产物与界面是页面级的：只为当前查看的会话刷新，避免后台会话把别人的成果区覆盖掉。
        if (id !== sessionIdRef.current) return;
        void refreshArtifacts(id);
        // 完成的那一轮已落库，交给历史接管；取消/失败保留实时条目，才能看到「已取消」与错误步骤。
        if (tracker.snapshot(id)?.finalStatus === 'done') void settleIntoTimeline(id);
      },
    };
  }

  /** 本地起跑/终态时同步侧栏标记；刷新列表后以后端返回值为准。 */
  function syncRunMarker(id: string) {
    const entry = tracker.snapshot(id);
    const active =
      entry && !entry.terminal && entry.runId
        ? {
            id: entry.runId,
            status: entry.status === 'queued' ? ('queued' as const) : ('running' as const),
          }
        : null;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, activeRun: active } : s)));
  }

  /** 产物事件先乐观上屏，终态后由 refreshArtifacts 用落库版本覆盖。 */
  function addOptimisticArtifact(ev: AgentEvent) {
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

  async function run() {
    const currentGoal = goal;
    const ready = pendingRef.current.filter(
      (a): a is PendingAttachment & { dto: AttachmentDto } => a.status === 'ready' && !!a.dto,
    );
    const attachmentIds = ready.map((a) => a.dto.id);
    const submitted: RunAttachment[] = ready.map((a) => ({
      id: a.dto.id,
      kind: a.kind,
      filename: a.filename,
      mime: a.dto.mime,
      size: a.size,
      ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
    }));
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setGoal('');
    setError('');
    composerRef.current?.focus();
    let sid = sessionId;
    // 只有本次真正占位成功才在 finally 释放：提前 return 不能把别人的在途流标记删掉。
    let claimed = false;
    try {
      // 草稿态首次发送才建会话，并把选中的模型固化到会话上。
      if (!sid) {
        const created = await createSession(
          selectedModel || undefined,
          selectedAssistantId || undefined,
          selectedMode,
        );
        setSessions((prev) => [created, ...prev]);
        if (created.model) setSelectedModel(created.model);
        setSelectedMode(created.mode);
        setSessionId(created.id);
        sid = created.id;
      }
      if (streamingRef.current.has(sid)) return;
      streamingRef.current.add(sid);
      claimed = true;
      // 会话创建成功后再清空输入区：失败时可保留附件重试。
      // 已发送附件的预览 URL 转交给 tracker 条目，切换/清理时统一释放。
      const sentIds = new Set(ready.map((a) => a.localId));
      for (const p of pendingRef.current) {
        if (!sentIds.has(p.localId) && p.previewUrl) releaseUrl(p.previewUrl);
      }
      pendingRef.current = [];
      setPendingAttachments([]);
      // 新建的 run 在库里就是 queued，先按排队展示，等状态帧或首个步骤再切执行中。
      const st = tracker.begin(sid, currentGoal, submitted);
      syncRunMarker(sid);
      const res = await streamTask(sid, currentGoal, attachmentIds);
      if (!res.ok) {
        // 错误响应通常带 JSON body 但没有 SSE 帧；不在此拦截就会静默结束、既不报错也无事件。
        const detail = await res.text().catch(() => '');
        throw new Error(`stream_failed_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      await consumeRunStream(res, st, makeHandlers(sid));
      if (!st.terminal && st.runId) {
        // 流在没有终态的情况下断开：用游标重连一次补回断档事件；
        // 取消也一样重连，终态帧丢失时由这次重连回放 status(canceled)+done 收尾。
        const retry = await streamRun(st.runId, st.lastSeq);
        if (!retry.ok) throw new Error(`stream_failed_${retry.status}`);
        setError('');
        await consumeRunStream(retry, st, makeHandlers(sid));
      }
      if (!st.terminal) {
        tracker.settle(sid, 'failed');
        syncRunMarker(sid);
        setError('连接已断开，可刷新恢复');
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
      if (sid) {
        // 起跑失败也要收尾，否则该会话输入框会一直只读。
        tracker.settle(sid, 'failed');
        syncRunMarker(sid);
      }
    } finally {
      if (claimed) streamingRef.current.delete(sid);
    }
  }
```

- [ ] **Step 7: 重写 `stopRun` 与 `decide`**

```ts
  async function stopRun() {
    if (!runId || stopping || !sessionId) return;
    tracker.markStopping(sessionId);
    try {
      // 不本地结束运行：等取消的终态事件到达，由事件流统一收尾。
      const result = await cancelRun(runId);
      // 取消已受理但终态帧可能还在路上：保持 stopping，由 onTerminal 收尾。
      if (result.status === 'done' || result.status === 'failed' || result.status === 'canceled') {
        tracker.applyStatus(sessionId, result.status, null);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        tracker.clearStopping(sessionId);
        return;
      }
      // 取消失败时运行可能仍在继续：恢复按钮，并提示可重试。
      tracker.clearStopping(sessionId);
      setError(errorText(err));
    }
  }

  async function decide(confirmId: string, approved: boolean) {
    if (!runId || !sessionId) return;
    // 立即禁用按钮（在 tool_result 回来之前给出反馈）；随后由事件流自然收尾。
    tracker.decide(sessionId, confirmId, approved);
    try {
      await confirmRun(runId, confirmId, approved);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      // 决策未送达（网络/上游故障）：撤销乐观禁用，否则按钮会一直卡到闸门超时。
      tracker.undecide(sessionId, confirmId);
      setError(errorText(err));
    }
  }
```

- [ ] **Step 8: 避免同一提问重复渲染**

把问题导航的 `userAnchors` 里这一行：

```ts
    ...(submittedGoal.trim() !== '' ? [{ id: 'pending', text: submittedGoal }] : []),
```

改为：

```ts
    ...(showPendingTurn && submittedGoal.trim() !== ''
      ? [{ id: 'pending', text: submittedGoal }]
      : []),
```

把会话里的提问气泡条件：

```tsx
                {(submittedGoal || submittedAttachments.length > 0) && (
```

改为：

```tsx
                {showPendingTurn && (submittedGoal || submittedAttachments.length > 0) && (
```

- [ ] **Step 9: 删除会话时清理条目**

在 `handleDeleteSession` 的 `await deleteSession(id);` 之后加一行：

```ts
    releaseEntry(id);
```

- [ ] **Step 10: 全量检查**

```bash
pnpm --filter @ai-office/web exec tsc --noEmit
pnpm --filter @ai-office/web test
```

Expected: 无类型错误；vitest 全绿。若出现 `setSubmittedGoal/setLiveText/setEvents/setRunStatus/... 未定义`，说明还有旧引用，逐一改成对应的 tracker 调用或派生值。

- [ ] **Step 11: 提交**

```bash
git add apps/web/src/app/page.tsx
git commit -m "$(cat <<'EOF'
refactor(web): 工作台运行态迁移到按会话跟踪

原先事件、正文增量、决策、游标都是页面单例，切走即丢。改为由 RunTracker
按会话保存，页面只从快照派生视图，为后续切换会话与后台挂回打底。
EOF
)"
```

---

### Task 4: 切换会话不中断 + 自动挂回

**Files:**
- Modify: `D:\ws\ai\agent\work_sylar\apps\web\src\app\page.tsx`

- [ ] **Step 1: 新增挂回与回放函数**

在 `run()` 之后加：

```ts
  /**
   * 按 runId 从头回放并接续。页面刷新、切到由其他标签页发起的运行、
   * 断线后重新选中会话都走这一条路径。
   */
  async function attachRun(id: string, runIdToAttach: string) {
    // 已有在途条目（运行中或正在写流）就不要再挂一条；终态条目可以换成后端报的新 run。
    const existing = tracker.snapshot(id);
    if (streamingRef.current.has(id) || (existing && !existing.terminal)) return;
    streamingRef.current.add(id);
    const st = tracker.attach(id, runIdToAttach, -1);
    try {
      const res = await streamRun(runIdToAttach, -1);
      if (!res.ok) throw new Error(`stream_failed_${res.status}`);
      await consumeRunStream(res, st, makeHandlers(id));
      if (!st.terminal) {
        // relay 对终态 run 会回放终态帧；没有终态说明连上了但流提前结束。
        tracker.settle(id, 'failed');
        syncRunMarker(id);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      tracker.settle(id, 'failed');
      syncRunMarker(id);
      setError('连接已断开，可刷新恢复');
    } finally {
      streamingRef.current.delete(id);
    }
  }

  /** 本地没有在途流、但后端说该会话还在跑：按 activeRun 挂回。 */
  async function ensureAttached(id: string) {
    const existing = tracker.snapshot(id);
    if (streamingRef.current.has(id) || (existing && !existing.terminal)) return;
    const active = sessionsRef.current.find((s) => s.id === id)?.activeRun;
    if (active) await attachRun(id, active.id);
  }
```

- [ ] **Step 2: 首屏 `refresh()` 后挂回**

在 `refresh()` 里这段：

```ts
      if (pick) {
        setSessionId(pick.id);
        if (pick.model) setSelectedModel(pick.model);
        void loadHistory(pick.id);
      }
```

改成：

```ts
      if (pick) {
        setSessionId(pick.id);
        if (pick.model) setSelectedModel(pick.model);
        void loadHistory(pick.id);
        // 刷新前就在跑的会话：relay 会回放已落库步骤并接续实时事件。
        if (pick.activeRun) void attachRun(pick.id, pick.activeRun.id);
      }
```

- [ ] **Step 3: 放开切换与新建**

把 `handleSelect` 换成：

```ts
  function handleSelect(id: string) {
    const needLoad = loadedHistoryRef.current !== id;
    if (id !== sessionId) {
      const target = sessions.find((s) => s.id === id);
      // 历史会话没有固化的模型：展示当前默认模型，实际运行由服务端按默认值解析。
      setSelectedModel(target?.model ?? defaultModel);
      // 已终结的条目由落库历史接管；运行中的条目继续在后台消费。
      dropFinishedEntry(id);
      setSessionId(id);
      resetConversation();
      if (needLoad) void loadHistory(id);
      // 刷新、断线或别的标签页发起的运行：按 activeRun 回放挂回。
      void ensureAttached(id);
      return;
    }
    if (needLoad) {
      // 同一会话回看：落库历史接管已结束的那一轮，避免同一轮展示两次。
      dropFinishedEntry(id);
      void loadHistory(id);
    }
  }
```

把 `handleNewSession` 开头的：

```ts
  function handleNewSession() {
    if (running) return;
```

改为：

```ts
  function handleNewSession() {
```

（其余不变：切走时当前会话的运行条目留在 tracker，后台流继续消费。）

- [ ] **Step 4: 去掉侧栏禁用**

把 `<AppShell ...>` 里的：

```tsx
      sessionDisabled={running}
```

整行删除。此时其它会话的运行不影响输入框：`canSend`/`readOnly` 只看当前会话条目。

- [ ] **Step 5: 全量检查**

```bash
pnpm --filter @ai-office/web exec tsc --noEmit
pnpm --filter @ai-office/web test
```

Expected: 无类型错误、测试全绿。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/app/page.tsx
git commit -m "$(cat <<'EOF'
feat(web): 切换会话不再中断任务并支持挂回

切换/新建原先被 running 守卫拦住，且切走就丢失运行态。现在切换只换当前视图，
后台流继续消费；首屏或切回发现 activeRun 时按 afterSeq 回放并接续。
EOF
)"
```

---

### Task 5: 侧栏运行/排队标记

**Files:**
- Modify: `D:\ws\ai\agent\work_sylar\apps\web\src\components\app-shell.tsx`
- Modify: `D:\ws\ai\agent\work_sylar\packages\web-core\src\globals.css`

- [ ] **Step 1: 移除 `sessionDisabled` 属性**

`apps/web/src/components/app-shell.tsx`：

- 删除接口里的 `sessionDisabled?: boolean;`
- 删除解构里的 `sessionDisabled,`
- 「新建任务」按钮的 `disabled={sessionDisabled}` 整行删除
- 会话行的 `disabled={sessionDisabled}` 整行删除

- [ ] **Step 2: 会话项渲染状态点与文案**

把会话行里的：

```tsx
                      <span className="wb-session-title">{s.title}</span>
                      <span className="wb-session-time">{relativeTime(s.createdAt)}</span>
```

替换为：

```tsx
                      <span className="wb-session-title">{s.title}</span>
                      <span
                        className={`wb-session-time${s.activeRun ? ' wb-session-running' : ''}`}
                      >
                        {s.activeRun && (
                          <span
                            className={`wb-session-dot is-${s.activeRun.status}`}
                            aria-hidden="true"
                          />
                        )}
                        {s.activeRun
                          ? s.activeRun.status === 'queued'
                            ? '排队中'
                            : '运行中'
                          : relativeTime(s.createdAt)}
                      </span>
```

- [ ] **Step 3: 加样式**

在 `packages/web-core/src/globals.css` 的 `.wb-session-time { ... }` 块（约 2816 行）之后追加：

```css
.wb-session-time.wb-session-running {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--mint-strong);
}

.wb-session-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.wb-session-dot.is-queued {
  opacity: 0.55;
}

.wb-session-dot.is-running {
  animation: wb-session-pulse 1.4s ease-in-out infinite;
}

@keyframes wb-session-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
```

- [ ] **Step 4: 全量检查**

```bash
pnpm --filter @ai-office/web exec tsc --noEmit
pnpm --filter @ai-office/web test
```

Expected: 无类型错误、测试全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/app-shell.tsx packages/web-core/src/globals.css
git commit -m "$(cat <<'EOF'
feat(web): 侧栏展示会话运行与排队标记

多会话并行后，用户需要在不打开会话的情况下看到谁在跑。会话项用状态点+文案
替换相对时间，本地起跑/终态即时更新，刷新后以后端 activeRun 为准。
EOF
)"
```

---

### Task 6: 真栈手工验收

**Files:** 无代码改动，不产生提交。

- [ ] **Step 1: 构建共享包并重启前端**

DTO 改了 `dist`，dev server 需要重启才能拿到新类型/新模块：

```bash
pnpm --filter @ai-office/shared build
```

重启 BFF（:4000）与 web（:3000）、admin（:3001）的 dev 进程。BFF 需要 Redis（`REDIS_URL`）与 runtime（:4001）在跑。

- [ ] **Step 2: 两个会话并行**

1. 聊天页输入一个长任务（如「调研竞品并输出结论」），发送。
2. 运行中点击「新建任务」，在第二个会话发送另一个长任务。
3. 预期：两个会话都不被中断；侧栏分别显示「运行中」（排队时显示「排队中」）。
4. 「新建任务」按钮与所有会话项在运行中保持可点。

- [ ] **Step 3: 切回与挂回**

1. 在两个会话间反复切换，预期各自都能看到实时进度（事件、增量正文、执行中提示）。
2. 运行中刷新页面，预期自动回到 URL 指定或最新会话，并从已落库步骤回放到最新，随后继续实时更新。
3. 任一会话点「停止」，预期只影响该会话；另一个继续运行。

- [ ] **Step 4: 边界**

1. 运行中删除其它空闲会话：正常。
2. 运行中删除当前运行会话：沿用后端 409 提示「会话还有任务在运行」。
3. 断网/重启 BFF 后等待流断开：当前会话出现「连接已断开，可刷新恢复」，输入框恢复可用；刷新后按 `activeRun` 挂回。

- [ ] **Step 5: 回归**

```bash
pnpm --filter @ai-office/bff exec vitest run src/sessions/sessions.service.test.ts
pnpm --filter @ai-office/bff typecheck
pnpm --filter @ai-office/web test
```

Expected: 全绿。若手工验收发现问题，回到对应 Task 修复后重新提交，不要追加「验收修复」这类空提交。

---

## 自检结果

- **Spec 覆盖**：DTO/查询（Task 1）、RunTracker 与折叠（Task 2）、页面改造与终态收尾（Task 3）、切换不中断 + 回放挂回 + 去掉 `if (running) return`（Task 4）、侧栏标记（Task 5）、手工验收（Task 6）。
- **两处必要的细化（偏离 spec 字段/步骤，但不改架构）**：
  1. `RunEntry` 多存 `goal`/`attachments`：提问气泡与附件预览属于「这一轮」而不是页面，不存进条目切回就会丢。
  2. done 终态后把条目交回落库历史（`settleIntoTimeline`）：执行器在发布终态前已写入 assistant 消息，因此历史是完整的；不交接的话下一轮发送覆盖条目时上一轮答案会从界面消失。取消/失败不交接，保留条目才能显示「已取消」与错误步骤。
- **占位符**：无 TBD/TODO，所有代码步骤给出完整实现。
- **类型一致性**：`RunEntry.status` 统一为 `RunPhase`；`finalStatus` 统一为 `FinalRunStatus`；页面派生变量沿用旧名（`events/liveText/running/runStatus/queuePosition/decisions/submittedGoal/submittedAttachments/stopping/runId`），渲染层无需大面积改名；tracker 方法名在全计划中一致（`begin/attach/applyStep/applyStatus/applyDone/applyError/applyTerminal/settle/markStopping/clearStopping/decide/undecide/has/clear/snapshot`）。
