# 跨会话并行运行与运行态跟踪设计

> 目标：工作台切走会话不打断任务，不同会话可同时运行，切回立即看到实时进度。

**Goal:** 把前端单会话运行态改成按会话跟踪的多运行态，配合后端返回的「会话当前 run」，实现切换会话不中断、跨会话并行、切回自动挂回。

**Architecture:** 后端在 `SessionSummary` 上回填 `activeRun`（当前 queued/running 的 run）；前端用纯 TS 的运行态表（RunTracker）按 sessionId 保存每条流的状态与事件，页面只渲染当前会话条目。运行中的流常驻后台继续消费，页面刷新/断线时用 `activeRun` + `/api/runs/:id/stream?afterSeq` 回放重挂。

**Tech Stack:** NestJS（BFF）、Prisma、Next.js 15 + React 19、Vitest、原生 fetch + SSE。

---

## 1. 现状与问题

- 执行端本来就是异步的：`TasksController.run` 只做校验、落库、`queue.submit` 入队，随后 `relay.attach` 只负责把事件转发给浏览器。队列 worker（`RUN_QUEUE_CONCURRENCY`）独立执行，客户端断开只触发 `settle(false)` 停止转发，不会取消 run。
- 问题都在前端（`apps/web/src/app/page.tsx`）：
  1. `handleSelect`（约 700 行）与 `handleNewSession` 都有 `if (running) return`，运行中无法切换会话。
  2. `running / runId / lastSeqRef / events / liveText / runStatus / queuePosition` 是单会话全局状态，切走即丢失上下文，切回只能看落库历史，看不到正在进行的 run。
  3. `SessionSummary` 不含运行状态，前端无从得知某个会话是否仍在跑。
- 结论：不需要改执行链路，只需要（a）后端把「会话当前 run」暴露出来；（b）前端把运行态按会话拆开。

## 2. 目标与非目标

**目标**

- 运行中可自由切换会话/新建任务；切换不影响服务端执行。
- 不同会话可并发运行（同一会话保持串行：上一轮未结束不能发新消息）。
- 切回运行中的会话能继续看实时进度（回放 + 实时接续），页面刷新同样可恢复。
- 侧边栏对运行中/排队中的会话给出标记。

**非目标**

- 不改变执行器、队列、记忆、问答缓存的任何语义。
- 不引入服务端的「每会话单 run」约束（现已没有，保持）。
- 不做跨标签页的运行态实时同步（各标签页独立挂流即可）。
- 不做全局运行托盘/桌面通知。

## 3. 方案选型

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A（采用） | 每个会话各自一条 SSE，后台常驻消费，状态存前端表 | 切回零延迟、状态完整；代价是 N 条连接（实际并发很小） |
| B | 切走即断开，切回按 DB 回放重挂 | 省连接；切回有回放闪烁，`assistant_delta` 实时增量不落库会短暂缺失 |
| C | 轮询 run 状态 | 简单但失去流式体验，不采用 |

B 的「回放重挂」作为 A 的兜底路径保留：页面刷新、断线重连、切换到由其他标签页发起的运行，都走同一条 `streamRun(runId, afterSeq)` 代码路径。

## 4. 后端改动

### 4.1 DTO

`packages/shared/src/dto.ts` 的 `SessionSummary` 增加：

```ts
/** 会话当前正在排队或执行的运行；无则为 null。 */
activeRun: { id: string; status: 'queued' | 'running' } | null;
```

### 4.2 查询

`apps/bff/src/sessions/sessions.service.ts`：

- `list()`：拿到当页（≤ `SESSION_PAGE_SIZE`）会话 id 后，一次查询
  `Run.findMany({ where: { task: { sessionId: { in: ids } }, status: { in: ['queued', 'running'] } }, orderBy: { startedAt: 'desc' }, select: { id, status, task: { select: { sessionId } } } })`，
  按 sessionId 取最新一条回填；同一会话理论上只会有一条（前端串行发送），异常多条时取最新。查询失败回填 `null` 并记 `warn`（侧边栏标记缺失不应让列表整体失败）。
- `detail()`：同样回填，单条查询。
- 其余字段与排序不变。

不新增接口、不改表结构：`Task @@index([sessionId])` 与 `Run @@index([taskId])`、`Run @@index([status, startedAt])` 已覆盖该查询。

## 5. 前端运行态模型

### 5.1 RunTracker（`apps/web/src/lib/run-tracker.ts`）

纯 TS、无 React 依赖，便于单测。以会话为键保存：

```ts
export interface RunEntry {
  runId: string;
  status: 'queued' | 'running' | 'stopping';
  queuePosition: number | null;
  lastSeq: number;          // 已消费的最大 step 序号，重连游标
  events: AgentEvent[];     // 已渲染的步骤事件
  liveText: string;         // 当前 think 的增量文本（未落库）
  decisions: Record<string, boolean>;
  terminal: boolean;
}
```

接口：

- `begin(sessionId, runId)`：新建/覆盖条目，`lastSeq = -1`。
- `attach(sessionId, runId, afterSeq)`：为刷新/重挂准备条目，保留游标。
- `apply(sessionId, event)`：复用现有 `run-stream.ts` 的事件折叠规则（`assistant_delta` 追加 `liveText`、`think` 清空 `liveText`、其余入 `events`、`status` 更新状态与排队位次、终态置 `terminal`）。
- `settle(sessionId, status)`：终态收尾。
- `clear(sessionId)`、`snapshot(sessionId)`、`has(sessionId)`。

`run-stream.ts` 里已有的折叠逻辑抽成纯函数供 tracker 与页面共用，避免两套行为。

### 5.2 页面改造（`apps/web/src/app/page.tsx`）

- 删除 `running / runId / runStatus / queuePosition / liveText / events / lastSeqRef` 这组单会话状态；改为 `trackerRef` + 一个 `version` 递增触发器（或 `useReducer`），当前会话的视图由 `tracker.snapshot(sessionId)` 派生。
- `run()` 改为 `startRun(sessionId)`：发送后写入 tracker，流在后台继续消费；`onDone/onTerminal` 只更新 tracker 与当前列表项。
- `handleSelect` / `handleNewSession` 去掉 `if (running) return`；切换时把当前流保留在后台（不 abort）。
- 输入框只读条件改为「当前会话存在未终结条目」，其余会话可正常发送。
- 挂回：`handleSelect` 与首屏 `refresh()` 之后，对选中会话若 `snapshot` 不存在且 `activeRun !== null`，执行 `streamRun(activeRun.id, -1)` 回放 + 接续；已是终态的 run 由 relay 直接回放步骤并下发终态帧，页面随之收尾。
- 产物/标题刷新：原先依赖 `running` 的 effect 改为当前会话条目从非终态变终态时触发 `refreshArtifacts(sessionId)` 与 `syncSessionTitle(sessionId)`。
- 停止按钮作用于当前会话条目的 `runId`；`stopping` 标记也存在 tracker。

### 5.3 侧边栏（`apps/web/src/components/app-shell.tsx`）

- 会话项在 `activeRun` 非空时展示状态点与文案（`running` → 运行中；`queued` → 排队中，有 `queuePosition` 时省略位次文案）。
- 本地起跑/终态时即时更新 `sessions` 中该会话的 `activeRun`；切换会话或首屏加载时以后端列表值为准。
- 样式沿用现有会话项样式，不新增布局。

## 6. 边界与降级

| 场景 | 行为 |
| --- | --- |
| 页面刷新时仍有 run | 列表返回 `activeRun`，选中的会话自动回放重挂；其他会话显示标记 |
| 流断开 | 现有 finally 重连一次的逻辑保留，游标来自 tracker 的 `lastSeq` |
| 其他标签页取消 | 重连/挂回收到 `status(canceled)` + `done`，条目收尾并清标记 |
| 会话被删除 | 现有删除逻辑不变；tracker 中对应条目 `clear` |
| `activeRun` 查询失败 | 列表回填 `null`，仅失去标记，不影响运行与切换 |
| 队列满 | 现有 429 `queue_full` 提示不变，不新增并发上限 |
| 同一会话重复发送 | 前端只读拦截；服务端未加锁，属既有行为，不在本期变更 |

## 7. 测试

- `apps/web/src/lib/run-tracker.test.ts`：两个会话的事件交替写入互不串扰；`assistant_delta` 累加与 `think` 清空；`status` 更新排队位次；终态后 `terminal=true`；`clear` 后 `snapshot` 为空。
- `apps/web/src/lib/run-stream.test.ts`：抽取折叠纯函数后保持既有断言通过。
- `apps/bff/src/sessions/sessions.service.test.ts`：列表按会话回填最新 `activeRun`；同会话多条只取最新；查询失败回填 `null` 不抛错；`detail` 同样回填。
- 手工验收：A 会话发长任务 → 切到 B 会话再发任务 → 两个会话同时出现运行中标记 → 各自切回都有实时进度 → 任一停止只影响该会话。

## 8. 观测

- 前端不新增埋点；挂回失败沿用现有 `setError('连接已断开，可刷新恢复')`。
- 后端 `activeRun` 查询失败走 `Logger.warn`，带页大小与会话数，不打印内容。
