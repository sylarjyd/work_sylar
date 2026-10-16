# M3「安全」· 工具权限 + 确认卡片 + 代码沙箱 · 设计文档

- 日期：2026-10-16
- 状态：待用户审阅
- 关联：上游 `docs/superpowers/specs/2026-10-15-ai-office-agent-design.md` 第 5.2 / 5.4 / 7 / 8 节
- 前置：M2（工具系统 + 文档生成 + 成果区）已交付并端到端验证

## 1. 背景与目标

M2 让 Agent「会干活」：生成文档、落存储、可下载。但**任何工具都能被模型无门槛调用**——一旦引入破坏性能力（代码执行、文件写删），用户将失去最终控制权。M3 补上安全边界，对齐上游「**破坏性操作需确认**」。

**目标**
- 工具契约引入**权限三级** `safe / confirm / blocked`。
- **确认交互闭环**：agent-loop 遇 `confirm` 工具时**挂起**，下发确认卡片；用户在网页允许/拒绝后 loop 继续。
- **`code.exec` 代码沙箱**：隔离执行模型给的代码，逃逸与超时被拦。
- 沿用 M1/M2 的三层解耦与 SSE 契约；新增一种 step 类型承载确认请求。

**非目标（本期明确不做）**
- `file.*` 工具、删除→回收站、修改前自动备份（依赖 `file.*`，推迟到引入该子系统时落地）。
- 两阶段可续跑 / 确认态跨 runtime 重启恢复（记入生产 backlog P10）。
- `blocked` 级的实际使用者（契约留位；v1 无标注为 `blocked` 的内置工具）。
- 多 Agent 派生、子 Agent 编排。

## 2. 已确认的关键决策

| 议题 | 决策 | 理由 |
|---|---|---|
| 范围边界 | 仅「权限机制 + 确认卡片 + `code.exec` 沙箱」 | 破坏性操作缺真实落点（无 `file.*`），先把机制做扎实 |
| 确认态驻留 | runtime 内存闸门（`Map<runId,…>`）+ 内部确认端点 | 与 v1「无状态单实例」现状匹配；跨重启恢复是 M5 队列化（P10）的活 |
| 反向通道 | BFF `POST /api/runs/:id/confirm` 转发到 runtime | runtime 不暴露公网；鉴权与归属校验收口 BFF |
| 拒绝语义 | 回填 `tool_result(ok:false, denied:true)`，loop 继续 | 模型可改口/换方案；拒绝与超时用 `reason` 区分，不引入第二套终止逻辑 |
| 沙箱技术 | 子进程 + Node `--permission` + 受限 harness | 真·进程隔离、无原生依赖（Windows 可用）；`isolated-vm` 需 C++ 构建链，风险高 |
| 沙箱能力面 | 无 fs、无网络、无子进程、无 worker，仅纯计算 | 最小攻击面；`code.exec` 的用途是计算而非 I/O |
| 超时 | 确认 120s、执行 5s（均可配） | 防挂起泄漏与死循环 |

## 3. 架构与数据流

### 3.1 分层变更

- **shared**：`StepType` 增 `'confirm_request'`；新增 `ToolPermission` / `ConfirmRequest` / `ConfirmDecision` 类型。
- **agent-runtime**：
  - `tools/types.ts` 的 `Tool` 增**必填** `permission`。
  - 新增 `confirm/broker.ts`（确认闸门）。
  - `agent-loop.ts` 按权限分流；`confirm` 工具先 `yield confirm_request` 再 `await` 闸门。
  - 新增 `tools/code-exec.ts`（沙箱子进程）。
  - `server.ts` 增 `POST /runs/:id/confirm`；连接 `close` 时 `broker.cancel`。
- **bff**：新增 `POST /api/runs/:id/confirm`（JWT + 归属校验 + 转发）。`recordStep` 天然兼容新 step 类型，`confirm_request` 落库成审计行。
- **web**：`lib/api.ts` 增 `confirmRun`；工作台识别 `confirm_request` 事件 → 渲染内联确认卡片。

### 3.2 一次「确认并执行 code.exec」的往返

```
Web                BFF                          Runtime
 | POST /api/sessions/:id/tasks (SSE) ──────────▶  runAgent loop
 | ◀─ step tool_call(code.exec,{code}) ───────────|
 | ◀─ step confirm_request{confirmId,tool,args} ──|  loop await gate.request(runId,…)
 | [渲染确认卡片]                                  |
 | POST /api/runs/:rid/confirm ─▶ JWT+归属校验
 |                                POST /runs/:rid/confirm (token) ─▶ gate.resolve()
 | ◀─ 200 {ok,matched} ◀──────── (matched=false = 重复/过期/未知)
 | ◀─ step tool_result(code.exec, ok, approved) ──|  放行 → 执行沙箱 → 回填
 | ◀─ … 继续 / done ──────────────────────────────|
```

**不变式**：`confirm_request` 必须在 `await` **之前** yield。否则卡片无法下发、BFF 也无从落库。

### 3.3 关键边界：等待确认时客户端断开

web 断开 → BFF 的 `onClientGone` 取消上游读取 → runtime 侧 `res` 触发 `close` → `broker.cancel(runId)` 把挂起闸门按**拒绝**兑现 → loop 继续（对已断开的连接写入无副作用）。若不显式 cancel，闸门会悬停至超时才释放，期间占用内存且模型上下文悬挂。

## 4. 共享契约（packages/shared）

```ts
// protocol.ts
export type StepType = 'think' | 'tool_call' | 'tool_result' | 'artifact' | 'confirm_request';

// dto.ts
export type ToolPermission = 'safe' | 'confirm' | 'blocked';

/** `confirm_request` step 的 payload：用户需据此决定是否放行。 */
export interface ConfirmRequest {
  confirmId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** BFF 确认端点的请求体。 */
export interface ConfirmDecision {
  confirmId: string;
  approved: boolean;
}
```

决策结果**不新增 step 类型**，而是并入随后的 `tool_result.payload`：`{ tool, ok, approved?: boolean, denied?: boolean, reason?: 'user_denied' | 'confirm_timeout' }`。

> `packages/shared/src/protocol.ts` 的 `SSE_EVENT_NAMES` 不变（确认仍走 `step` 事件），仅 `StepType` 扩展。web 的 `renderStep` 对未知类型返回空串的前向兼容逻辑保留。

## 5. 工具契约与权限（apps/agent-runtime）

```ts
// tools/types.ts
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 权限等级：safe 直接执行；confirm 需用户确认；blocked 一律拒绝。**必填**，杜绝漏标即静默放行。 */
  permission: ToolPermission;
  execute(args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}
```

内置工具标注（对齐上游 §5.2）：

| 工具 | 权限 |
|---|---|
| `web.search` / `web.fetch` | `safe` |
| `doc.docx` / `doc.xlsx` / `doc.pptx` | `safe` |
| `code.exec` | `confirm` |

## 6. 确认闸门（apps/agent-runtime/src/confirm/broker.ts）

```ts
export interface ConfirmGate {
  /** 挂起等待决策；超时按 approved=false + reason=confirm_timeout 兑现。同一 runId 至多一个挂起。 */
  request(
    runId: string,
    confirmId: string,
    timeoutMs: number,
  ): Promise<{ approved: boolean; reason?: 'user_denied' | 'confirm_timeout' }>;
  /** 兑现挂起闸门；confirmId 不匹配或不存在返回 false（幂等，不抛错）。 */
  resolve(runId: string, confirmId: string, approved: boolean): boolean;
  /** 连接断开兜底：按拒绝兑现并清理。 */
  cancel(runId: string): void;
}
```

- 内部 `Map<runId, { confirmId, settle, timer }>`；`settle` 只兑现一次。
- `request`：若该 runId 已有挂起（理论不应发生，工具调用串行），直接拒绝新请求，避免状态错乱。
- 闸门实例在 `createRuntimeServer` 内创建一份（runtime 单实例），注入 loop deps 与确认端点。

### 6.1 agent-loop 变更

工具执行分支按 `tool.permission` 分流：

| 权限 | 行为 |
|---|---|
| `safe` | 执行（现状不变） |
| `blocked` | **不执行**，回填 `tool_result{ ok:false, blocked:true }` |
| `confirm` | `confirmId = randomUUID()` → `yield step('confirm_request', { confirmId, tool, args })` → `await gate.request(...)`。**放行**：执行工具，其 `tool_result` 附 `approved:true`；**拒绝/超时**：不执行，回填 `tool_result{ ok:false, denied:true, reason }` |

- 事件序列固定为 `tool_call` → `confirm_request`（仅 confirm 工具）→ `tool_result`。
- `RunDeps` 增可选 `confirm?: ConfirmGate`；未注入（如既有单测）时 `confirm` 工具按拒绝处理（fail-safe），保证老测试不误放行。

## 7. 代码沙箱（apps/agent-runtime/src/tools/code-exec.ts）

**执行模型**
```
spawn(process.execPath,
      ['--permission', `--max-old-space-size=${MB}`, harnessPath],
      { stdio: ['pipe', 'pipe', 'pipe'] })
```
- 代码经 **stdin** 送入（避免为代码文件开 fs 读权限）。
- `--permission` 默认拦 fs / `child_process` / `worker_threads` / 原生 addon。
- 已实测：Node v22.13.1 支持 `--permission`，默认拒绝 fs 读、拒绝 `child_process`；**但不拦网络**（socket 能到达连接层）。

**harness（受限作用域，收口网络缺口）**
- 一小段随 runtime 一同构建的 JS；读 stdin 取代码，在**受限作用域**内执行：
  - 不暴露 `require` / `process` / `globalThis.fetch` / 网络模块；
  - 仅保留纯计算原语 + `print()`（输出捕获）；
  - 用 `vm.runInNewContext(code, sandbox)` 隔离全局——`vm` 只做作用域隔离，**真正的安全边界是「子进程 + 权限模型」**（分层防御）。
- 结果以 JSON 写 stdout。

**资源与输出**
| 限制 | 默认 | 手段 |
|---|---|---|
| 墙钟超时 | 5000ms | 到点 `child.kill('SIGKILL')`，返回 `{ ok:false, timeout:true }` |
| 内存 | 128MB | `--max-old-space-size` |
| 输出 | 64KB | 累积超限即截断并 kill |

**工具契约**
- 入参：`{ code: string, timeoutMs?: number }`（`language` 固定 JS）。
- 返回：`{ ok: boolean, stdout: string, stderr: string, durationMs: number, timeout?: boolean }`。

**待验证假设（实施首步）**：`--permission` 下 node 仍需加载入口 harness，可能须 `--allow-fs-read=<harnessPath>` 精准授权（只授权 harness 自身，**不**开放用户可用的 fs）。若成立，则此授权写死为 harness 绝对路径，不随代码变动。

## 8. BFF 确认端点（apps/bff）

- `POST /api/runs/:id/confirm`（`JwtGuard`）
  - 校验 body：`confirmId` 非空字符串、`approved` 布尔；不合法 → 400。
  - **归属校验**：`runId → task → session`，要求 `session.tenantId === user.tenantId && session.userId === user.sub`；否则 404（不泄露存在性）。需 `TasksService` 增 `assertRunOwned(runId, tenantId, userId)`。
  - 转发 runtime `POST /runs/:id/confirm`（带 `x-agent-runtime-token`）。
  - 映射：runtime 200 → `{ ok:true, matched }`；runtime 404 → 404；上游不可达 → 502。
- `tasks.controller` 的流式循环：`confirm_request` step 走默认分支即可（`recordStep` 落库），**不得**被当作终止信号。

## 9. Web 确认卡片（apps/web）

- `lib/api.ts` 增 `confirmRun(runId, confirmId, approved)` → `POST /api/runs/:runId/confirm`。
- 工作台在事件流分发时**先**识别 `confirm_request` → 渲染内联卡片（工具名 + 入参 JSON + 「允许」/「拒绝」按钮）；决策后按钮禁用并显示「已允许 / 已拒绝」，等待随后的 `tool_result` 呈现结果。
- `render-step.ts` 为 `confirm_request` 返回空串（卡片由工作台单独渲染，文本渲染器保持纯文本职责）。
- 等待确认期间禁用目标输入（同一会话单 run）。

## 10. 数据模型 / schema 影响

- **无新表、无迁移**：确认态在 runtime 内存；决策结果并入 `Step`。
- `Step.type` 是裸 TEXT（非 Prisma enum），新增取值**不需要迁移**。
- 需同步更新 `docs/db/schema.sql` 中「可选加固」的 `Step_type_check`：允许值追加 `'confirm_request'`。

## 11. 配置项（根 `.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONFIRM_TIMEOUT_MS` | `120000` | 确认等待上限，到点按拒绝兑现 |
| `CODE_EXEC_TIMEOUT_MS` | `5000` | 沙箱单次执行墙钟上限 |
| `CODE_EXEC_MAX_OLD_SPACE_MB` | `128` | 沙箱子进程堆上限 |
| `CODE_EXEC_MAX_OUTPUT_BYTES` | `65536` | stdout/stderr 累计截断阈值 |

## 12. 错误处理

| 场景 | 处理 |
|---|---|
| 用户拒绝 | `tool_result{ ok:false, denied:true, reason:'user_denied' }`，loop 继续 |
| 确认超时 | 同上，`reason:'confirm_timeout'` |
| `blocked` 工具被调用 | `tool_result{ ok:false, blocked:true }`，不执行 |
| 确认端点 `confirmId` 过期/重复 | `matched:false`，200 返回，不改动已决状态 |
| 确认端点：非本人 run | 404（不泄露存在性） |
| 等待确认时客户端断开 | runtime `close` → `broker.cancel` → 按拒绝兑现 |
| 沙箱超时 / OOM / 非法代码 | 沙箱返回 `{ ok:false, … }`；工具层不抛，转 `tool_result ok:false` |
| 沙箱逃逸尝试（fs/net/child_process/worker） | 权限模型拒绝 → 子进程以 `ERR_ACCESS_DENIED` 退出 → 记入 stderr 返回 |
| 沙箱 harness 无法加载（`--permission` 下） | 启动即报错，实施首步验证并定 `--allow-fs-read=<harness>` |

## 13. 测试策略

- **shared**：`confirm_request` 帧解析的前向兼容；新 DTO 形状。
- **runtime**
  - `confirm/broker.test.ts`：兑现、超时兑现、幂等（重复 resolve）、`confirmId` 不匹配、`cancel`。
  - `agent-loop.test.ts` 增测：`safe` 直跑；`confirm` 工具 → 先 `confirm_request` 后 `tool_result`；允许则执行、拒绝/超时则回填拒绝；`blocked` 不执行；**未注入闸门时 confirm 工具 fail-safe 拒绝**。
  - `tools/code-exec.test.ts`（**逃逸用例**）：`require('fs')`、`require('child_process')`、`require('worker_threads')`、`fetch()`、死循环（超时 kill）、内存炸弹（OOM）、输出炸弹（截断）、正常计算与输出捕获。
- **bff**：`POST /api/runs/:id/confirm` 的归属校验（越权 404）、body 400、转发、上游 404 透传、上游不可达 502。
- **web**：`confirm_run` 调用；工作台对 `confirm_request` 渲染卡片、决策后禁用按钮（组件/逻辑测试）。
- **e2e（真模型）**：下达一个会触发 `code.exec` 的目标 → SSE 出现 `confirm_request` → 经确认端点放行 → 出现 `tool_result` 且结果为沙箱输出；拒绝路径则 `tool_result.ok=false`。**需真实 `DEEPSEEK_API_KEY`**：`MockGateway` 只发 `web.search`，覆盖不到本期。

## 14. 未决 / 已知取舍

- 确认态在 runtime 内存：runtime 重启则挂起确认丢失（记入 P10，M5 队列化时改落库续跑）。
- 沙箱为「受限计算」而非强隔离：无网络/无 fs 已被 harness + 权限模型收口，但进程内 V8 漏洞超出本期防御面（必要时可升级容器沙箱）。
- `code.exec` 只支持 JS（对齐 v1 单语言），多语言留后续。
- 确认卡片展示原始入参；本期不做参数脱敏（`code.exec` 入参即需用户审阅的代码，无敏感凭据）。
- BFF 未持久化 `confirmId`：归属校验基于 run 归属而非 confirmId，重复/伪造 confirmId 由 runtime 闸门兜底。
