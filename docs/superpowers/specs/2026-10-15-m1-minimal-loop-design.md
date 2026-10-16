# M1 最小闭环 · 设计文档

- 日期：2026-10-15
- 状态：待用户审阅（含 3 处标注「待确认」的默认决策）
- 上游：`docs/superpowers/specs/2026-10-15-ai-office-agent-design.md`
  （本文件是其 §8 里程碑「M1 最小闭环」的实施级细化）
- 前置：M0 已完成并合并（`f4f0b4a`），三层骨架 + SSE 端到端已跑通

## 1. 目标与非目标

**M1 验收标准**（对齐上游 §8）：能在网页端**注册/登录**，输入一个目标，
看到 Agent 用**真模型**逐步干活，并调用**联网工具**返回真实结果。

**做什么**
- 账号：注册 / 登录 / JWT 鉴权
- 会话：session + message 持久化，多会话
- Agent Loop：真模型驱动（plan → act → observe），替换 M0 的 `runFakeAgent`
- 模型网关：单模型抽象（可在 M5 扩多模型）
- 内置工具 2 个：`web.search`、`web.fetch`
- 三端串联：web → BFF（鉴权+建任务）→ agent-runtime（跑 loop）→ SSE 回流 → web 渲染

**M1 明确不做**（各归属后续里程碑）
- 沙箱执行、确认卡片、工具权限分级 → M3
- 文档生成 `docx/xlsx/pptx`、成果区 → M2
- 知识库 RAG、MCP / 连接器 → M4
- 计费、用量计费、可观测看板 → M5
- 多 Agent / 子 Agent、Redis/BullMQ 队列、JSON-RPC（见 §3 决策 5）
- OTP / 手机号登录（见 §3 决策 3）

## 2. 关键决策（含默认值）

> 上游设计文档 §9 列出的未决问题，M1 必须落地其中与本期相关的几项。
> 下面每条都给了**默认选择**与理由；标注「待确认」的是成本/外部依赖较重的项，
> 若不认可请在评审时指出，我会改写计划。

| # | 议题 | 默认决策 | 理由 | 状态 |
|---|---|---|---|---|
| 1 | 首个模型 | **DeepSeek**（OpenAI 兼容 `/chat/completions`） | 中文原生、便宜、协议为标准 OpenAI，网关抽象最省事；无需为 M1 引入厂商 SDK | 待确认（需 `DEEPSEEK_API_KEY`） |
| 2 | 模型网关形态 | **自研薄网关**（一个 `ModelGateway` 接口 + `OpenAICompatProvider`） | M1 只需单模型；抽象点收口在「一次 chat 补全」，M5 扩多模型/限流/埋点不动上层 | 待确认 |
| 3 | 认证方式 | **邮箱 + 密码（argon2 哈希）+ JWT(access)** | OTP 需要邮件/短信服务商，为 M1 引入外部依赖不划算；密码式最快闭环，OTP 留接口 | 待确认（与上游 §7 默认「OTP」有出入） |
| 4 | 持久化 | **Postgres + Prisma**；dev/compose 起 PG，测试用同一 PG（见 §11） | 上游 §4 定 Postgres；账号/会话/step 是 M1 核心数据，晚迁代价高。Redis/队列推后 | 待确认 |
| 5 | BFF↔runtime 协议 | **沿用 REST + SSE**，暂不上 JSON-RPC | M0 已是 REST `/prompt`+SSE；M1 只需加 `sessionId` 与鉴权透传，上 JSON-RPC 是净增复杂度 | — |
| 6 | 联网工具实现 | 工具接口 + provider 可配置；默认 **Tavily**（有 key）／**DuckDuckGo**（无 key 回退） | 使「调用联网工具」在无任何额外 key 时也能演示；有 Tavily key 时质量更高 | 待确认 |
| 7 | Agent 循环停止条件 | 模型返回无 tool_call 即结束；设最大轮次（默认 8）与总 token 上限 | 防失控；上游 §5.1 要求「轮次有 token 预算上限」 | — |

## 3. 架构与组件落点

沿用 M0 的四包结构，新增内容按层归属：

```
packages/shared      扩展：鉴权/会话/任务的 DTO 与错误码；StepType 复用
apps/bff             + auth 模块(register/login/JWT guard)
                     + sessions/messages 模块(CRUD)
                     + tasks 模块(建 task → 调 runtime → SSE 透传 + 写 step)
                     + Prisma(PG) 数据访问
apps/agent-runtime   - runFakeAgent → 真 Agent Loop
                     + model-gateway(接口 + OpenAI 兼容 provider)
                     + tools(registry + web.search/web.fetch)
                     （保留 /health；/prompt 变为真 loop）
apps/web             + 登录/注册页
                     + 工作台页(已有 page.tsx 扩展：按 step.type 区分渲染)
                     已有 sse-parser 复用
```

**边界原则**（延续上游 §3.2）：BFF 不跑 Agent、不碰模型；runtime 不碰账号/计费；
模型调用只发生在 runtime 的网关里。

## 4. 数据模型（M1 用到的表）

只落 M1 真正读写的表（上游 §4 的其余表在各自里程碑再建）：

| 表 | 关键字段 | M1 用途 |
|---|---|---|
| `user` | id, tenant_id, email(uniq), password_hash, status, created_at | 注册登录 |
| `tenant` | id, type(personal), name, plan | 注册时自动建 personal 租户（为多租户预留） |
| `session` | id, tenant_id, user_id, title, status, created_at | 会话列表 |
| `message` | id, session_id, role(user/assistant/tool), content, tokens, seq | 对话历史（喂给模型） |
| `task` | id, session_id, goal, status(queued/running/done/failed), created_at | 一次「下达目标」 |
| `run` | id, task_id, status, started_at, ended_at, cost | 一次 Agent 执行实例 |
| `step` | id, run_id, seq, type, payload(jsonb), ts | 每一步；**SSE 数据源 + 审计/回放基础**（上游 §4.2） |

- 所有业务表带 `tenant_id`（上游 §4 硬约束）。
- `step.type` 复用 shared 的 `StepType`（think/tool_call/tool_result/artifact）。

## 5. 协议（M1 具体形态）

### 5.1 web ↔ BFF（REST + SSE，均需 Bearer JWT，注册/登录除外）
- `POST /api/auth/register` `{email, password}` → 201 `{token, user}`
- `POST /api/auth/login` `{email, password}` → 200 `{token, user}`
- `GET  /api/sessions` → 会话列表
- `POST /api/sessions` `{title?}` → 新建会话
- `GET  /api/sessions/:id/messages` → 历史消息
- `POST /api/sessions/:id/tasks` `{goal}` → **SSE 流**（`text/event-stream`）
  - 事件沿用 M0：`event: step|usage|done|error`，`step.data` 为 `AgentEvent`

### 5.2 BFF ↔ agent-runtime（REST + SSE）
- `GET  /health`（已有）
- `POST /runs` `{runId, sessionId, messages: [{role,content}], goal}` → SSE 流
   - BFF 把 shared 的 `AgentEvent` 原样透传给 web；同时把每个 `step` 写库
   - runtime 不再自己生成 `runId`，改由 BFF 传入（便于落库与回放对齐）

> 说明：M0 的 `POST /prompt {goal}` 被 `POST /runs` 取代；`runFakeAgent` 删除。
> 若需要保留 `/prompt` 的 M0 行为作回归，不保留——M0 的端到端测试改为打 `/runs`。

## 6. Agent Loop 与模型网关

### 6.1 循环（上游 §5.1 的精简实现）
```
messages = 历史 + 用户 goal
for round in 1..MAX_ROUNDS:
    resp = model.chat(messages, tools)
    yield step(think, {text: resp.content})          # 模型的思考文本
    if resp.toolCalls is empty:
        break                                        # 结束条件
    for call in resp.toolCalls:
        yield step(tool_call, {tool, args})
        result = tools.execute(call)                 # 见 §7
        yield step(tool_result, {tool, ok, preview})
        messages += assistant(call) + tool(result)
yield done
```
- 每步 `seq` 从 0 递增；`runId` 由请求带入。
- 工具调用采用 OpenAI 兼容的 function-calling 结构；网关负责把各家的差异抹平到这一结构。

### 6.2 模型网关
```ts
interface ChatRequest { messages: Msg[]; tools: ToolSchema[]; maxTokens?: number }
interface ChatResponse { content: string; toolCalls: {id,name,args}[]; usage: {in,out} }
interface ModelGateway { chat(req: ChatRequest): Promise<ChatResponse> }
```
- `OpenAICompatProvider`：`baseUrl`+`apiKey`+`model` 来自 env，POST `{baseUrl}/chat/completions`。
- **无 key 回退**：`DEEPSEEK_API_KEY` 缺失时，网关返回一个**确定性 mock**（按 goal 关键词
  决定是否发起 `web.search`）。这样单测/CI/本地演示无需外部依赖，且 M1 的 loop 逻辑可测。
- `usage` 事件：把每轮 token 累计后发 `event: usage`（M5 计费的埋点前置）。

## 7. 工具系统（M1 只 2 个）

- **声明式注册**（上游 §5.2）：`{ name, description, parameters(JSON-Schema), execute }`。
  M1 不实现权限分级（那是 M3），但 `parameters` 用 JSON-Schema 描述，直接喂给模型。
- `web.search(query) → [{title,url,snippet}]`
  - provider：Tavily（`TAVILY_API_KEY`）优先，否则 DuckDuckGo（无需 key）。
- `web.fetch(url) → {text}`：抓取并转文本（去标签），截断到上限防上下文爆炸。
- 工具异常：捕获后作为 `tool_result {ok:false, error}` 反馈给模型继续循环，不中断整个 run。

## 8. 一次「下达目标」的数据流

1. web：`POST /api/sessions/:id/tasks {goal}`（带 Bearer JWT）。
2. BFF：guard 验 JWT → 查 session 归属 → 建 `task`/`run` → 组装 `messages`（历史+goal）。
3. BFF → runtime：`POST /runs`，透传 `runId/sessionId/messages/goal`。
4. runtime：跑 §6.1 loop → SSE 吐 `step`（每个工具调用走 §7）。
5. BFF：边收边转发给 web；同时把 `step` 写库；结束时更新 `task/run` 状态。
6. web：`createSseParser`（M0 已有）解析，按 `type` 渲染思考/工具调用/结果。

## 9. 错误处理（上游 §7 的 M1 子集）

- 未鉴权/越权访问他人 session → 401/403（不泄露存在性）。
- 模型失败 → 网关重试 1 次；仍失败则发 `event: error` 并置 `run=failed`（fallback 模型留 M5）。
- 工具失败 → 记 `tool_result.ok=false`，交由模型决定下一步。
- 上游不可达 → 沿用 M0 的 `502 upstream_unreachable`（已实现）。
- SSE 断连续传 → M1 不做（上游列为非功能项，随 M5 可观测一并处理）。

## 10. 非功能

- 安全：密码 argon2 哈希；JWT 用 HS256 + `JWT_SECRET`；`tenant_id` 行级隔离（每查询带 tenant 条件）；不记录明文密码。
- 配置：`.env`（`DATABASE_URL`、`JWT_SECRET`、`DEEPSEEK_API_KEY`、`TAVILY_API_KEY`、`AGENT_RUNTIME_URL`、`NEXT_PUBLIC_BFF_URL`）；`.env.example` 入库，`.env` 忽略。
- 可观测：结构化日志；每个 run/step 有 id 可追踪（M5 再上 trace 后端）。

## 11. 测试策略（上游 §7）

- **agent-runtime**：loop 单测（mock 网关 + mock 工具），覆盖「多轮工具调用」「无工具即结束」「达到轮次上限」「工具报错继续」。
- **模型网关**：对本地 mock HTTP server 的契约测试；断言无 key 时走确定性回退。
- **工具**：`web.fetch` 的 HTML→文本单测；`web.search` provider 选择逻辑单测（打桩）。
- **BFF**：auth guard 单测（有效/过期/无 token）；注册登录集成测试；`tasks` 转发契约测试（起假 runtime）。
- **web**：`sse-parser`（M0 已有）+ 工作台按 `step.type` 渲染的单测。
- **DB**：dev 与测试共用 `docker compose` 起的同一个 PG **实例**，但用**独立 database**（`ai_office` / `ai_office_test`），避免测试污染开发数据。
- **M0 既有测试**：`apps/agent-runtime/src/server.test.ts` 与 `fake-agent.test.ts` 针对 `/prompt` 与 `runFakeAgent` 编写，M1 删除二者后需一并改写为针对 `/runs` 与真 loop 的新测试（不作为回归保留）。

## 12. 里程碑内拆分（供 writing-plans 参考，非最终）

1. shared：新增 DTO/错误码；runtime `/runs` 协议类型。
2. bff：Prisma + PG 接入、`user/tenant` 表 + 注册登录 + JWT guard。
3. bff：session/message CRUD。
4. agent-runtime：ModelGateway（含无 key 回退）+ 单测。
5. agent-runtime：工具注册表 + `web.search`/`web.fetch` + 单测。
6. agent-runtime：真 Agent Loop 替换 `runFakeAgent` + 单测；改 `/prompt`→`/runs`。
7. bff：tasks 模块（建 task/run、透传 SSE、写 step、更新状态）。
8. web：登录页 + 工作台渲染改造（带 JWT 调 BFF）。
9. 端到端联调 + README 更新。

## 13. 待确认清单（评审时请逐条定夺）

1. 模型用 **DeepSeek**、你有可用的 `DEEPSEEK_API_KEY` 吗？（决策 1）
2. 认证 M1 走**邮箱+密码**（而非上游默认的 OTP），可以吗？（决策 3）
3. 持久化 M1 就上 **Postgres+Prisma**（放弃「先用内存/JSONL 快速闭环」）？（决策 4）
4. ORM 选 **Prisma**（vs Drizzle）？（决策 4 子项）
5. 联网工具默认 **Tavily，无 key 时回退 DuckDuckGo**，可以吗？（决策 6）
