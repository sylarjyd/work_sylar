# M5b-3 任务队列 · 设计文档

- 日期：2026-10-26
- 状态：待实施
- 关联：`docs/develop/05-dev-plan.md` §5.2、`docs/superpowers/specs/2026-10-20-m5b-2-observability-design.md`
- 上游需求：任务排队、取消/重试、断点续跑（复用 `Step` checkpoint）

## 1. 背景与目标

当前一次运行的生命周期完全绑定在 HTTP 请求上：`POST /api/sessions/:id/tasks`
在请求内完成归属校验、计费预占、建 `Task/Run`、调用 runtime `/runs` 并原样转发
SSE。客户端断开后 BFF 仍会排空上游，但进程一旦重启或上游中断，运行即丢失，
且没有任何排队、取消、重试能力。

本期目标：

1. **排队**：运行入口改为入队，worker 按全局并发与租户并发执行；排队期间不占用积分。
2. **取消**：可取消排队中或执行中的运行，停止 runtime 计算并按实际用量结算。
3. **重试**：失败运行可手动重试；基础设施类失败自动按 checkpoint 续跑。
4. **断点续跑**：每完成一轮 `plan→act→observe` 落一次 checkpoint，恢复时从最后完整轮继续，
   已完成轮的工具调用不重放，`seq` 连续。
5. **可观测**：队列深度、等待时长、取消/重试次数进入既有指标与告警体系。

非目标（后续期）：多优先级队列、跨区域调度、定时任务、分布式公平调度算法、
浏览器端任务列表页。

## 2. 架构总览

```
web ──POST /api/sessions/:id/tasks──▶ BFF: 预检 + 快照 + 建 Task/Run(queued) + 入队
                                        │
                                        ▼
                                   BullMQ queue "runs"
                                        │
                                        ▼
                          BFF worker（进程内，可独立部署）
                            ├─ 计费预占 beginRun
                            ├─ Run → running
                            ├─ fetch runtime /runs（SSE）
                            ├─ Step/Artifact/Checkpoint 落库
                            ├─ 发布事件 run:<id>:events（Redis）
                            └─ 结算 / 收尾终态
                                        │
web ◀──SSE（回放 DB steps + 订阅 Redis）──┘
```

- **事件总线**：`RunEventBus` 接口，两种实现：
  - `RedisRunEventBus`：`PUBLISH run:<runId>:events` / `SUBSCRIBE`；生产与默认队列模式。
  - `LocalRunEventBus`：进程内 `EventEmitter`；无 Redis 的内联模式与单测。
- **控制总线**：`run:<runId>:control`，承载 `confirm` / `cancel` 消息，
  使 BFF HTTP 进程与 worker 不在同一进程时仍可路由。
- **执行器抽取**：把 `TasksController.run()` 中「调 runtime、解析 SSE、落 Step/Artifact、
  记录用量、结算、收尾」抽为 `RunExecutor`；内联模式与 worker 复用同一执行器。
- **兼容策略**：`POST /api/sessions/:id/tasks` 仍返回 `text/event-stream`，
  前端主要调用方式不变；内部由「入队 + 挂接转发」实现。未配置 `REDIS_URL`
  时自动退化为内联执行（开发/单机）。

## 3. 数据模型

### 3.1 状态机

`Task.status` 与 `Run.status` 统一为：

```
queued ──▶ running ──▶ done
   │           ├────▶ failed
   ├───────────┴────▶ canceled
```

- `queued`：已入队未执行（`Task.status='queued'`，`Run.status='queued'`）。
- `running`：worker 已预占额度并调用 runtime。
- `canceled`：排队/执行被用户取消。
- 终态：`done | failed | canceled`。

### 3.2 Prisma 变更

```prisma
model Task {
  id         String    @id @default(uuid())
  sessionId  String
  goal       String
  status     String    @default("queued")
  /// 入队时的运行快照：消息历史、助手配置、会话模型、traceId；重试复用。
  input      Json?
  /// 已创建的运行次数（含重试）。
  attempts   Int       @default(0)
  lastError  String?
  queuedAt   DateTime  @default(now())
  startedAt  DateTime?
  endedAt    DateTime?
  createdAt  DateTime  @default(now())
  session    Session   @relation(fields: [sessionId], references: [id])
  runs       Run[]

  @@index([sessionId])
  @@index([status, queuedAt])
}

model Run {
  id                String    @id @default(uuid())
  taskId            String
  attempt           Int       @default(1)
  status            String    @default("queued")
  startedAt         DateTime?
  endedAt           DateTime?
  cancelRequestedAt DateTime?
  traceId           String?
  task              Task      @relation(fields: [taskId], references: [id])
  steps             Step[]
  artifacts         Artifact[]
  checkpoint        RunCheckpoint?

  @@index([taskId])
  @@index([status, startedAt])
  @@index([traceId])
  @@index([startedAt])
}

/// 最后完整轮次的状态快照；仅保留每 run 一行。
model RunCheckpoint {
  runId     String   @id
  /// 下一轮起始下标（已完成 round+1 轮）。
  round     Int
  /// 下一事件序号（已落库步骤的最大 seq + 1）。
  seq       Int
  /// 自上次 checkpoint 以来新增的 assistant/tool 消息增量，避免重复存储附件内容。
  deltas    Json
  usage     Json
  /// 已落库的产物 ID；恢复时删除未列入的记录，避免半轮产物重复。
  artifactIds Json
  updatedAt DateTime @updatedAt
  run       Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
}
```

说明：

- `Run.startedAt` 由 `@default(now())` 改为可空：排队期间没有开始时间；
  创建时间看 `Task.createdAt` / `Run.attempt`。历史数据已有值，无需回填。
- 不对 `Task.input` 加密：只含用户自己的消息与附件引用，无密钥。
- `comments.sql` 不纳入本期变更（遵循仓库既有约束）。

## 4. 协议与类型（`packages/shared`）

```ts
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export const SSE_EVENT_NAMES = [
  'step', 'usage', 'done', 'error', 'status', 'checkpoint',
] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/** 排队/执行状态变更（非 Step，不入库）。 */
export interface RunStatusEvent {
  runId: string;
  status: RunStatus;
  /** 仅 queued 时有意义：同租户前方等待数。 */
  position?: number;
}

/** 一轮完成后的内部 checkpoint 事件；BFF 消费，不转发给浏览器。 */
export interface RunCheckpointEvent {
  round: number;
  seq: number;
  /** 本轮新增的 assistant/tool 消息（不含附件内容）。 */
  deltas: unknown[];
  usage: Array<{ model: string; input: number; output: number }>;
}

export interface RunResume {
  round: number;
  seq: number;
  deltas: unknown[];
  usage: Array<{ model: string; input: number; output: number }>;
}

export interface RunRequest {
  // ...既有字段不变
  /** 断点续跑：由 BFF 从 RunCheckpoint 读出后下发。 */
  resume?: RunResume;
}
```

- `AgentEvent` 与 `StepType` 不变；checkpoint/status 不是 Step。
- `RunStatus` 以 `string` 落库，DTO 层使用该联合类型。

## 5. API 设计

### 5.1 创建运行（保持路径与流式契约）

`POST /api/sessions/:id/tasks`

1. 既有预检全部保留（归属、goal、附件、模型、参数），但**移除计费预占**。
2. 生成 `runId`，`TasksService.enqueue()` 在一个事务内：
   - 建 `Task(status='queued', input=快照)`；
   - 建 `Run(id=runId, status='queued', attempt=1)`；
   - 落用户消息并认领附件（复用现有 `prepare` 事务逻辑）。
3. 写入队列；租户排队数超限返回 `429 queue_full`。
4. 建立 SSE 响应并挂接该 run（见 5.2）；首批事件为
   `status {status:'queued'}` → 后续 `step` / `usage` / `done|error`。
5. 入队失败（Redis 不可用且未开内联）：回滚已建记录并返回 `503 queue_unavailable`。

> 兼容：无 `REDIS_URL` 或 `RUN_QUEUE_ENABLED=0` 时走内联模式——同一执行器在请求内运行，
> 不入队；响应契约完全一致。

### 5.2 事件流

- `GET /api/runs/:id/stream`（新增，JWT + 归属校验）
  - 支持 `Last-Event-ID` 请求头或 `?afterSeq=`：只回放 `seq > afterSeq` 的步骤。
  - 先订阅频道并缓冲，再回放 DB 步骤，最后按 `seq` 去重刷出缓冲，避免回放与实时之间丢事件。
  - 回放后若 run 已终态：补发 `done`/`error` 并结束；否则保持连接，15s 心跳注释帧。
  - `checkpoint` 事件永远不转发；`status` 事件实时转发。
- 同一次创建的 `POST` 响应内部同样走挂接逻辑；客户端断开只结束本次挂接，
  worker 继续执行。

### 5.3 取消

`POST /api/runs/:id/cancel` → `{ status: RunStatus }`

- 归属校验（404 不泄露存在性）。
- `queued`：尝试移除队列 job；成功后置 `Run/Task.status='canceled'`、`endedAt`，
  不涉及计费。
- `running`：置 `cancelRequestedAt`，发布控制消息；worker 中止上游 fetch，
  runtime 在连接关闭时中止 agent loop；按已产生用量结算，无用量则释放预占，
  最终 `status='canceled'`。
- 终态：幂等返回 200 与当前状态。
- 竞态：取消与自然结束同时发生时，先写入终态者胜；`Run.status` 更新使用
  `where: { status: { in: ['queued','running'] } }` 条件更新，避免覆盖 `done`。

### 5.4 重试

`POST /api/runs/:id/retry` → `202 { runId, taskId }`

- 仅允许 `failed | canceled` 的 run；同一 Task 的新 `Run(attempt=attempt+1, status='queued')`，
  复制 `Task.input` 快照，清空新 run 的 checkpoint。
- 入队后前端用返回的 `runId` 走 `GET /api/runs/:id/stream`。
- 并发重试：以 `Task.attempts` 条件自增保证只建一个活动 run
  （`updateMany where { id, status in [...] } count===1`）。

### 5.5 管理端

- `GET /api/admin/tasks`：状态筛选新增 `queued | canceled`，返回 `attempts`、`queuedAt`。
- `POST /api/admin/runs/:id/cancel`、`POST /api/admin/runs/:id/retry`：`AdminGuard`，
  与用户侧共用 service，写审计 `run.cancel` / `run.retry`。
- 运行详情增加 `checkpoint` 摘要（round/seq/updatedAt）与 `attempt` 字段。

## 6. 队列执行

### 6.1 队列与 worker

- 队列名 `runs`（env `RUN_QUEUE_NAME`）；job 数据只含
  `{ runId, taskId, tenantId, userId, sessionId }`，不含消息与密钥。
- jobId = `runId`，天然去重。
- worker 并发：env `RUN_QUEUE_CONCURRENCY`（默认 4）。
- 租户并发：参数 `queuePerTenantConcurrency`（默认 2）。worker 取 job 后统计该租户
  `Run.status='running'` 的数量；达上限则 `job.moveToDelayed(Date.now()+2000)` 让出槽位，
  避免单租户占满全局并发。
- 租户排队上限：参数 `queueMaxPerTenant`（默认 50）。入队前统计该租户
  `Task.status='queued'` 数量，超限返回 `429 queue_full`。
- worker 生命周期由 `RunQueueModule` 管理：`OnApplicationBootstrap` 启动，
  `OnApplicationShutdown` 关闭；`RUN_QUEUE_ENABLED=0` 时不创建。

### 6.2 执行步骤（RunExecutor）

1. 加载 `Task.input` 快照与 checkpoint（若有）。
2. `billing.beginRun(runId, tenantId)`：
   - `RateLimitedError` → `moveToDelayed(retryAfter)`，不消耗尝试次数；
   - `InsufficientCreditsError` / `PlanExpiredError` → 终态 `failed`，发布 `error`。
3. `Run.status='running'`、`startedAt=now`、`Task.status='running'`、`startedAt=now`；
   首次运行回填会话模型（既有 `bindModel` 逻辑）。
4. 附件 `hydrateForRun`；失败则释放预占并终态 `failed`。
5. POST runtime `/runs`，携带 `RunRequest`（含 `resume`）与 traceparent。
6. 逐事件处理：
   - `step`：`recordStep`；`artifact`：落库并记录 artifact id；发布到事件总线。
   - `checkpoint`：upsert `RunCheckpoint`（含当前 artifact id 列表），不转发。
   - `usage`：缓存最新用量。
   - `error`：标记 failed。
7. 收尾（与现有逻辑一致）：有用量 → `recordUsage` + `settle`；无用量 → `releaseHold`；
   `finish(runId, taskId, status, assistantText, sessionId)`；发布 `done`/`error`。
8. runtime 调用失败：若属于基础设施类（建连失败、空闲超时、5xx、连接中断）且
   `attemptsUsed < queueMaxAttempts`，保留 run 为 `running`，从 checkpoint 续跑；
   否则终态 `failed`。

### 6.3 恢复与补偿

- 启动时（`OnApplicationBootstrap`）扫描 `status='running'` 且无对应队列 job 的 Run：
  有 checkpoint → 重新入队续跑一次；无 checkpoint 且超过 5 分钟未更新 → 标记 `failed`
  并释放预占。保留既有 `billing.sweeper` 作为最后一道兜底。
- BullMQ `maxStalledCount=1`：worker 崩溃后由 BullMQ 重新投递；worker 检测到
  checkpoint 即续跑。

## 7. 断点续跑

### 7.1 checkpoint 内容

runtime 在每轮所有工具执行完毕、消息回填之后发出 `checkpoint`：

```json
{
  "round": 3,
  "seq": 17,
  "deltas": [
    { "role": "assistant", "content": "...", "toolCalls": [...] },
    { "role": "tool", "toolCallId": "...", "content": "..." }
  ],
  "usage": [{ "model": "deepseek-chat", "input": 1200, "output": 340 }]
}
```

- `deltas` 只含本轮新增消息，不重复附件与历史，控制体积。
- 最后一轮（无工具调用）不需要 checkpoint：直接进入收尾。

### 7.2 恢复语义

- worker 在续跑前：删除该 run 中 `seq >= checkpoint.seq` 的 `Step` 与
  未列入 `artifactIds` 的 `Artifact`（半轮产物），再下发 `resume`。
- runtime 收到 `resume` 时：
  - 跳过附件准备与 system prompt 注入，直接使用
    `prepare(req.messages) + resume.deltas`（附件仍按原消息重新准备，保证内容一致）；
  - `round` 从 `resume.round` 继续，`seq` 从 `resume.seq` 继续；
  - `usageByModel` 以 `resume.usage` 为基线，最终仍只上报一次累计用量。
- 已完成轮的模型调用与工具调用不会重放；半轮最多重放一轮。
- confirm 卡片：半轮重放会重新下发 `confirm_request`，旧 confirmId 自然失效。

## 8. 取消与确认的跨进程路由

- `RunControlBus`（Redis `run:<id>:control`）：
  - `{ type:'confirm', confirmId, approved }`：worker 进程本地 `ConfirmBroker.resolve`；
  - `{ type:'cancel' }`：worker 中止 fetch（AbortController）并走取消收尾。
- `POST /api/runs/:id/confirm` 行为不变：校验后发布控制消息，返回 `{ok:true}`；
  worker 不在本进程时也无须感知。
- runtime：新增 run 注册表 `Map<runId, AbortController>`；SSE 连接 `close` 时
  `abort()`，agent loop 在每轮开始与工具循环内检查 `signal.aborted`，中止后不再发起
  新的模型调用与工具调用。BFF 中止 fetch 即触发该链路。
- 内联模式：总线为本地实现，行为一致。

## 9. 前端变更

### 9.1 web（用户端）

- 发送后处理新增 `status` 事件：`queued` 显示「排队中…」，`running` 清除。
- 运行中显示「停止」按钮，调用 cancel 并等待终态事件。
- 流异常断开且 run 未终态时，自动以 `Last-Event-ID` 重连一次
  `GET /api/runs/:id/stream`；重连失败给出明确错误。
- 终态 `canceled` 展示「已取消」，不当作失败。

### 9.2 admin（运营端）

- 任务列表：状态列支持 `queued/canceled`，展示 `attempts` 与排队时长。
- 任务详情：展示 attempt、checkpoint 摘要；提供「取消」「重试」按钮（带确认）。
- 运行时间线：checkpoint 不展示；`canceled` 使用中性色。

## 10. 可观测与审计

- 指标（BFF prom-client registry）：
  - `bff_run_queue_depth` Gauge（queued 数，按租户上限统计来源）；
  - `bff_run_queue_active` Gauge（running 数）；
  - `bff_run_queue_wait_seconds` Histogram（入队到开始）；
  - `bff_runs_canceled_total`、`bff_runs_retried_total`、`bff_runs_resumed_total` Counter。
- 日志（结构化，沿用 pino）：入队、开始、续跑、取消、重试、收尾各一条，
  字段 `runId/taskId/tenantId/attempt/durationMs`。
- 审计：管理端取消/重试写 `AdminAuditLog`（`run.cancel` / `run.retry`）。
- 告警：队列深度沿用 M5b-2 指标快照，可由 `MetricBucket` 现有规则扩展；
  本期至少把 `queue_depth` 纳入指标快照。

## 11. 配置

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `REDIS_URL` | env | 空 | 空则内联模式；配置后启用队列与跨进程事件 |
| `RUN_QUEUE_ENABLED` | env | 有 REDIS_URL 时为 1 | `0` 强制内联 |
| `RUN_QUEUE_NAME` | env | `runs` | 队列名 |
| `RUN_QUEUE_CONCURRENCY` | env | 4 | worker 全局并发（重启生效） |
| `queueMaxAttempts` | setting | 2 | 单次 job 内自动续跑次数（0–5） |
| `queuePerTenantConcurrency` | setting | 2 | 租户并发上限（1–8） |
| `queueMaxPerTenant` | setting | 50 | 租户排队上限（1–200） |

参数变更在下一个 job 开始前读取生效；全局并发仍由 env 控制（重启生效）。

## 12. 安全

- 入队与读取快照前均做归属校验；job 只携带 ID，不携带消息与密钥。
- `GET /api/runs/:id/stream` 每次连接重新校验归属；历史步骤按 runId 过滤。
- 控制频道消息必须校验 `runId` 与消息类型；未知类型忽略。
- 管理端取消/重试走 `AdminGuard` 并写审计。
- 取消接口幂等，且不允许通过重试串行放大额度：重试仍走 `beginRun` 的余额与 RPM 校验。

## 13. 兼容与迁移

- `prisma db push` 增加字段与新表；`Run.startedAt` 改可空，旧数据兼容。
- 旧运行记录（`done/failed`）不受影响；无 checkpoint 的历史 run 不可续跑。
- 未配置 Redis 的开发环境使用内联模式，行为与当前一致（除状态初值为 `queued` 后立即转 `running`）。
- 文档同步：`docs/develop/04-dev-guide.md`（本地验证队列）、
  `docs/deploy/06-deployment.md`（Redis 与 worker 部署）、`docs/develop/05-dev-plan.md`（M5b-3 状态）。

## 14. 验收标准

1. 并发 5 个运行、worker 并发 2：任意时刻最多 2 个 `running`，其余 `queued`；
   排队期间不产生 `CreditHold`。
2. 浏览器断开后运行继续，重连 `GET /api/runs/:id/stream` 能回放全部步骤并收到终态。
3. 取消排队中运行：立即 `canceled`，无计费痕迹；取消执行中运行：runtime 停止，
   按实际用量结算，`canceled` 且消息不落 assistant 文本。
4. 模拟 runtime 建连失败：自动续跑（有 checkpoint 时从下一轮继续），
   `Step.seq` 连续、无重复产物；超过自动续跑次数后 `failed`。
5. 手动重试失败运行：生成 `attempt+1` 的新 run，复用快照，新 run 独立计费与结算。
6. confirm 卡片在队列模式下仍可允许/拒绝，跨进程路由生效。
7. 管理端可筛选 `queued/canceled`、查看 attempts 与 checkpoint、取消/重试并留审计。
8. 指标端点暴露队列深度/活跃数/等待时长/取消/重试/续跑计数。
9. 全量 `pnpm test`、`pnpm build` 通过；无 Redis 时内联模式全流程可用。

## 15. 风险与取舍

| 风险 | 说明 | 应对 |
|---|---|---|
| 队列引入后调试复杂 | 两步式执行（入队 + 挂接） | 内联模式保留；结构化日志贯穿 runId |
| checkpoint 体积 | 消息增量已截断且只存 delta | 仅存本轮增量；checkpoint 单行覆盖写 |
| 半轮重放 | 崩溃发生在两轮之间或一轮内 | 只重放未完成轮；工具副作用以「已完成轮不重放」为边界 |
| 租户公平 | 无 BullMQ Pro 分组并发 | 全局并发 + 租户并发 + 延迟让位 |
| 事件丢失 | pub/sub 不持久 | 先落库后发布；挂接先订阅再回放 |
| Redis 故障 | 队列不可用 | 内联模式兜底；`RUN_QUEUE_ENABLED=0`；启动自检日志 |
