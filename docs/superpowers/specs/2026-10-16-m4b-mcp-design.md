# M4b「连接器 / MCP」· 接入外部 MCP Server + 工具自动发现 · 设计文档

- 日期：2026-10-16
- 状态：待用户审阅
- 关联：上游 `docs/superpowers/specs/2026-10-15-ai-office-agent-design.md` 第 5.2 / 5.3 / 6 / 8 节
- 前置：M3（权限 + 确认卡片 + 代码沙箱）、M4a（知识库 RAG）已交付并端到端验证
- 说明：M4「扩展」含两个独立子系统，拆为 **M4a 知识库 RAG**（已完成）与 **M4b 连接器/MCP**（本文档）。本文档只覆盖 M4b。

## 1. 背景与目标

上游 §5.2/§5.3 把 MCP 定为 Agent 接入**外部工具生态**的标准通道；dev-plan M4 表列出 M4-4（MCP Host）、M4-5（发现→注册表）、M4-6（Web 连接器页）。接入一个 MCP Server 后，其工具应自动可用——这是「会干活」迈向「接得进外部世界」的一步。M4b 交付这条闭环。

**目标**
- **接入即用**：新增一个 MCP Server → 自动发现其工具 → 并入 runtime 工具注册表 → 模型可调用。验收：**接入一个 MCP Server 后其工具可用**（dev-plan 原文）。
- **MCP Host**：stdio 传输；子进程常驻守护（心跳 ping + 崩溃退避重拉）。
- **连接器管理**：`/connectors` 页增删改查；凭证（MCP 的 `env`）**AES-256-GCM 加密入库**。
- 沿用 M1–M3：三层解耦、SSE 契约、权限/确认模型（发现的 MCP 工具默认 `confirm`）。

**非目标（本期明确不做）**
- **SSE / Streamable HTTP 远程传输**：v1 只做 stdio；传输层抽象留口，后续加实现即可。
- **Context Optimizer**（上游 §8）：MCP 结果不做裁剪/摘要。
- **命令白名单 / 容器沙箱隔离**：不设限；靠「管理员专属 + 审计 + 默认 confirm」兜底（§11）。
- **每租户化内置工具凭证**：Tavily 等仍走全局 env，不纳入连接器体系。
- **审计落 DB 表 / 连接器配额与限流**：属 M5 生产化。

## 2. 已确认的关键决策

| 议题 | 决策 | 理由 |
|---|---|---|
| 范围边界 | 核心集：stdio + 守护/心跳/退避 + 发现入注册表 + CRUD（凭证加密）+ Web 页 | 恰好对齐 dev-plan 验收；SSE/HTTP 与 Context Optimizer 拆后续 |
| 子进程归属 | **runtime 托管**（守护/心跳/退避）；连接器配置存 BFF | 与 M4a 同构：BFF 独占 DB、runtime 只执行；常驻态收敛在干重活的 runtime |
| 配置流向 | runtime **每次 run 开始**从 BFF 内部端点拉该租户启用连接器（含解密配置） | 增删改天然下次 run 生效，无需推送/轮询链路 |
| 安全姿态 | 连接器**租户级**、仅管理员增删改；命令**不白名单**；审计走 logger；发现的工具**默认 `confirm`** | 威胁模型是「管理员被诱导加恶意 Server」——白名单挡不住，审计 + 默认确认才挡得住 |
| 工具命名 | `mcp.<serverName>.<toolName>`；`serverName` 租户内唯一 | 与内置工具天然不撞，来源一眼可辨 |
| 客户端 | 官方 `@modelcontextprotocol/sdk`（`Client` + `StdioClientTransport`），封装在 `mcp/transport.ts` | MCP 是有版本的活规范，官方 SDK 为参考实现 |
| 凭证加密 | MCP `env` 整块 **AES-256-GCM**，密钥 `CONNECTOR_ENC_KEY`；DB 存密文+IV+tag | 凭证集中在一处、可轮换；缺失密钥 fail-fast |
| 新增校验 | **同步校验**：BFF→runtime（spawn+`initialize`+`tools/list`）→ 成功才落库、返回工具数 | 「加成功」即「工具可用」，兑现验收；不存永远跑不起来的 Server |
| 故障处理 | 工具调用失败 → `{ok:false,...}` **不中断 loop**；子进程崩溃守护退避自愈 | 一个 Server 抖动不应毁掉整个任务 |

## 3. 架构与数据流

### 3.1 分层变更

- **shared**：新增 `ConnectorDto`（`{ id, name, command, args, enabled, toolCount, status, createdAt }`——**不含 env**）、`McpToolInfo`（`{ name, description }`）类型，供 bff/web 复用。
- **bff**：
  - Prisma 新增 `Connector` 模型（配置 + 密文 env）；`User` 增 `role` 列（§4.1）。
  - 新增 `connector/`：`connector.service.ts`（CRUD、校验编排、加解密存取）、`connector.controller.ts`（对外 JWT+管理员路由 + 内部 token 路由）、`connector.module.ts`、`crypto.ts`（AES-256-GCM `encrypt`/`decrypt`）。
  - `app.module.ts` 注册 `ConnectorModule`。
- **agent-runtime**：
  - 新增 `mcp/`：`transport.ts`（`McpTransport` 抽象）、`stdio-transport.ts`（SDK 封装）、`host.ts`（`McpHost` 守护/心跳/退避/子进程池）、`discovery.ts`（拉配置 + 聚合工具）、`bff-connector-client.ts`（调 BFF 内部端点）。
  - `tools/registry.ts`：`createTools` 语义改为 **base tools**（不再包含 MCP）。
  - `server.ts`：`/runs` 处理器**按请求**拼 `[...baseTools, ...await buildMcpTools(tenantId)]` 再 `runAgent`（当前是启动时建一次的全局列表）；新增 `POST /connectors/validate`（复用 M3 `authorized()`）；`RuntimeDeps` 增 `mcpHost?`、`bffConnectorClient?`（测试可注入桩）；进程退出时关闭所有 MCP 子进程。
- **web**：新增 `/connectors` 页（列表/新增/编辑/删除）；`lib/api.ts` 增 `listConnectors` / `createConnector` / `updateConnector` / `deleteConnector`；`lib/role.ts`（或等价）读取当前用户角色以决定是否可写。
- **基础设施**：无新增外部服务（SDK 为 npm 依赖）。

**边界不变式**：runtime 不连 Postgres。连接器配置读写、加解密由 BFF 承担；runtime 只「拉解密配置 → spawn/调用 MCP 子进程」。

### 3.2 新增校验流（同步）

```
Web                BFF                                   Runtime
 | POST /api/connectors {name,command,args,env} ─▶
 |                  校验字段 / 查重名
 |                  调 runtime POST /connectors/validate ──▶ spawn(临时) → initialize
 |                                                          → tools/list → 销毁子进程
 |                  ◀─ {ok:true, tools:[{name,description}]} ────┘
 |  ← 201 {connector, toolCount}      成功：env 加密 → 建 Connector(enabled)
 |                                     失败(ok:false)：400 validate_failed{reason}，不落库
```

> **校验用临时子进程**：与常驻池隔离，校验完即销毁，不进入 `McpHost` 的复用池。

### 3.3 工具调用流

```
run 开始（tenantId 已知）
   │ runtime GET {BFF_INTERNAL_URL}/internal/connectors?tenantId=  (x-internal-token)
   │ ◀─ [{id,name,command,args,env,enabled}]（env 已解密）
   │ McpHost.ensure(cfg)：ready→复用；否则 spawn+initialize+tools/list→缓存工具
   │ buildMcpTools → Tool[]：名 mcp.<server>.<tool>，permission:'confirm'
   └─ runAgent 收到 [...baseTools, ...mcpTools]
        │ 模型调用 mcp.<server>.<tool>
        │ permission=confirm → 走 M3 确认卡片 → 批准后 McpHost.call(server,tool,args)
        └─ 子进程 tools/call → tool_result 回填
```

## 4. 数据模型

### 4.1 表

```
Connector: id(uuid) tenant_id name command args(json) env_encrypted(text)
           enabled(bool) created_by created_at updated_at
           unique(tenant_id, name)
```

- `env_encrypted` = `base64(IV ‖ authTag ‖ ciphertext)`，AES-256-GCM（§6.5）；读时解密，**永不回传前端**（`ConnectorDto` 不含 env）。
- `args` 用 Prisma `Json`（`string[]`）；`command`、`name` 常规列。
- 归属 `tenant_id`；CRUD 一律按租户过滤（沿用 M1 行级隔离）。`created_by` 为 JWT `sub`。
- `User` 增 `role String @default("admin")`：v1 单人部署「当前用户即管理员」；`AdminGuard` 校验 `req.user.role === 'admin'`（角色随 JWT 签发携带）。多租户真实角色体系属后续（§11）。

### 4.2 不落库的数据

- **工具清单不落 DB**：runtime 从活子进程 `tools/list` 拿、缓存于进程内存。避免 DB 与真实子进程状态不一致。
- **审计不落 DB**：走结构化 logger（§7、§11）。

## 5. 接口契约

### 5.1 BFF 对外（`@UseGuards(JwtGuard, AdminGuard)`）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/api/connectors` | `{ name, command, args?, env? }` | `201 { connector }`；重名 `400 duplicate_name`；校验失败 `400 validate_failed{reason}`；非管理员 `403 not_admin` |
| GET | `/api/connectors` | — | `200 [ConnectorDto]`（本人租户） |
| PATCH | `/api/connectors/:id` | `{ enabled?, name?, command?, args?, env? }` | `200 { connector }`；**改 `command`/`args`/`env` 时重新校验**；跨租户 `404` |
| DELETE | `/api/connectors/:id` | — | `204`；跨租户 `404`（不泄露存在性） |

> `ConnectorDto` 不含 `env`；`env` 仅在写入时接收，读取一律不回传。

### 5.2 BFF 内部（`x-internal-token`，复用 M4a 校验）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/internal/connectors?tenantId=` | — | `200 [{ id, name, command, args, env, enabled }]`（**env 已解密**，供 runtime）；token 不符 `401` |

### 5.3 runtime（`x-agent-runtime-token`，复用 M3 `authorized()`）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/connectors/validate` | `{ command, args, env }` | `200 { ok:true, tools:[{name,description}] }` 或 `{ ok:false, error }`；token 不符 `401` |

> `/connectors/validate` 用**临时子进程**校验后即销毁，不进入常驻池。

## 6. MCP Host（runtime `mcp/`）

### 6.1 transport.ts
```ts
interface McpTransport {
  connect(): Promise<void>;          // spawn + initialize 握手
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  ping(): Promise<void>;             // 心跳
  close(): Promise<void>;
}
```

### 6.2 stdio-transport.ts
- 封装官方 SDK `Client` + `StdioClientTransport`。
- spawn 时 env = **`process.env` 合并连接器 `env`**（保证 `PATH`/`npx` 等基础环境可用，连接器 env 覆盖同名键）。
- `connect()` 内做 `initialize`，超时上限 `MCP_INIT_TIMEOUT_MS`。

### 6.3 host.ts（`McpHost`）
- 内部：`Map<serverName, { transport, state: 'starting'|'ready'|'error', tools: McpToolInfo[], backoffMs, timer }>`。
- `ensure(cfg)`：`ready` → 直接复用；否则 spawn + `initialize` + `tools/list` → `ready` 并缓存工具；失败 → `state='error'` 且安排**退避重拉**。
- **心跳**：`ready` 态每 `MCP_HEARTBEAT_MS` 调 `ping()`；失败 → `close()` + `state='error'` + 退避重拉。
- **退避**：指数 `MCP_BACKOFF_BASE_MS`（1s）起，封顶 `MCP_BACKOFF_MAX_MS`（30s）；成功后重置。
- `call(server, tool, args)`：路由到对应 transport，超时上限 `MCP_CALL_TIMEOUT_MS`；未 `ready` → 抛错（由工具层转成 `{ok:false}`）。
- `closeAll()`：进程退出时关闭所有子进程（`server.ts` 注册 `onClose`/`SIGTERM`）。

### 6.4 discovery.ts + registry 拼装
- `buildMcpTools(tenantId, host, client): Promise<Tool[]>`：
  1. `client.fetchEnabled(tenantId)` → 连接器列表；
  2. 对每个启用连接器 `host.ensure(cfg)`；拉取失败或某 Server 拉起失败 → **跳过该 Server**（记日志），不影响其他；
  3. 聚合为 `Tool[]`：`name = mcp.<server>.<tool>`、`description` 取自 MCP、`parameters` 取自 MCP inputSchema、`permission: 'confirm'`、`execute(args, ctx) → host.call(server, tool, args)`。
- **server.ts**：`baseTools` 仍启动时构建；`/runs` 处理器改为
  `const tools = [...baseTools, ...await buildMcpTools(runReq.tenantId, mcpHost, bffClient)]`，
  再 `runAgent(runReq, { tools, ... })`。

### 6.5 crypto.ts（BFF）
- `encrypt(plain: string): string` → `base64(iv ‖ tag ‖ ciphertext)`（AES-256-GCM，随机 12 字节 IV）。
- `decrypt(blob: string): string`；密钥来自 `CONNECTOR_ENC_KEY`（32 字节 hex）。密钥缺失/长度错 → **启动 fail-fast**。
- 密钥读取集中在模块初始化，非法即抛错。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 新增/编辑：spawn 失败 / `initialize` 超时 / 协议错 | `400 validate_failed` + 原因，**不落库** |
| 连接器重名 | `400 duplicate_name` |
| 非管理员调 CRUD | `403 not_admin` |
| run 内拉连接器失败（BFF 不可达 / 非 2xx） | 记日志，本次 run **退化为无 MCP 工具**，不中断 agent loop |
| 某 Server 拉起失败 | 该 Server 工具**不注入**；host 退避重试；**不影响其他工具与 loop** |
| 工具调用：子进程挂 / 超时 / 协议错 | `{ ok:false, tool:'mcp.x.y', error:'mcp_call_failed', text:'外部工具暂时不可用' }`，**不中断 loop**；host 标记 `error` 并退避重拉 |
| MCP 返回超大结果 | v1 原样回填（受 `preview` 500 字截断）；裁剪/摘要属 Context Optimizer（§11） |
| `CONNECTOR_ENC_KEY` 缺失 / 长度错 | BFF 启动 **fail-fast** |
| `/internal/connectors` token 不符 | `401`（fail-closed，沿用 M4a：未设 token 时仅放行回环来源） |

## 8. Web UI

- **`/connectors` 页**：
  - 列表：`name` · `command` · `enabled` 开关 · 工具数 · 状态徽标（`ready`/`error`）· 删除按钮。
  - 新增/编辑表单：`name` / `command` / `args`（按行或空格分割）/ `env`（键值对，值用密码框）；提交后同步等待校验结果，失败展示 `reason`。
  - 删除二次确认。
  - **非管理员**：只读（隐藏新增/编辑/删除入口）。
- `lib/api.ts`：`listConnectors` / `createConnector` / `updateConnector` / `deleteConnector`。
- **工作台**：`mcp.*` 工具的 `tool_call`/`tool_result` 复用既有 step 类型，**无需新 `StepType`**；`permission:'confirm'` 走 M3 确认卡片。

## 9. 配置项

**runtime**
| 变量 | 默认 | 说明 |
|---|---|---|
| `MCP_HEARTBEAT_MS` | `30000` | 子进程心跳间隔 |
| `MCP_BACKOFF_BASE_MS` | `1000` | 崩溃重拉退避基数 |
| `MCP_BACKOFF_MAX_MS` | `30000` | 退避封顶 |
| `MCP_INIT_TIMEOUT_MS` | `10000` | `initialize` / 校验握手超时 |
| `MCP_CALL_TIMEOUT_MS` | `30000` | 单次 `tools/call` 超时 |
| `BFF_INTERNAL_URL` | 复用 M4a | runtime→BFF 内部端点地址 |
| `INTERNAL_TOKEN` | 复用 M4a | runtime→BFF 内部端点校验 |

**bff**
| 变量 | 默认 | 说明 |
|---|---|---|
| `CONNECTOR_ENC_KEY` | 空 | 32 字节 hex；**缺则 fail-fast** |
| `INTERNAL_TOKEN` | 复用 M4a | `/internal/connectors` 校验 |

同步更新：`.env.example`、`turbo.json` `globalPassThroughEnv`（新增 `CONNECTOR_ENC_KEY`、`MCP_*`）、`README.md`。

## 10. 测试策略

- **runtime**
  - `stdio-transport`：打桩 SDK `Client`，断言 `connect`/`listTools`/`callTool`/`ping` 转发与 env 合并。
  - `host`：`ensure` 复用（不重复 spawn）；崩溃 → 退避重拉（假时钟推进）；心跳失败 → `error` + 重拉；`closeAll`。
  - `discovery`：工具命名 `mcp.<server>.<tool>`、`permission==='confirm'`、`parameters` 取自 inputSchema；拉取失败降级为 `[]`；单 Server 失败不影响其他。
  - `bff-connector-client`：头部携带 `x-internal-token`；非 2xx 抛错。
  - `/connectors/validate`：成功返回 tools；spawn/握手失败返回 `{ok:false}`。
  - `registry`：base + mcp 拼装数量与顺序。
- **bff**
  - `crypto`：加解密往返；错误密钥 / 篡改 tag 抛错；非法 `CONNECTOR_ENC_KEY` fail-fast。
  - `connector.service`：CRUD、重名、租户过滤、**断言 DB 落库为密文**、内部端点解密回传、`created_by` 记录。
  - `connector.controller`：`403 not_admin`、`400 validate_failed`（透传 runtime reason）、跨租户 `404`。
  - `internal` 端点：token 不符 `401`。
- **web**：纯函数（状态徽标、env 表单校验）vitest。
- **端到端**：用一个**最小自建 echo MCP Server 脚本**（避免 `npx` 网络依赖与 flake）→ 新增校验通过 → 工具出现在模型工具列表 → 模型调用成功并回填结果。

## 11. 未决取舍（记入 backlog）

- **无命令白名单 / 沙箱隔离**：靠「管理员专属 + 审计 + 默认 confirm」兜底；强隔离（容器）留 M5。
- **runtime 多实例**：每实例各自托管 MCP 子进程，同一 Server 会 spawn 多份；v1 单实例无感，扩容时再议「共享 Host」。
- **无 SSE / HTTP 传输**：`McpTransport` 抽象留口，后续加一个实现即可。
- **无 Context Optimizer**（上游 §8）：超大 MCP 结果靠 `preview` 截断；有真实工具、观测到上下文膨胀后再做。
- **默认 confirm 不「记住批准」**：每次调用确认；per-connector `trusted → safe` 提升留后续。
- **审计仅 logger**：合规留存 / 可查询审计需 DB 表，属 M5。
- **连接器无配额 / 限流**：属 M5。
- **校验临时子进程开销**：每次新增/编辑 spawn 一次，短暂、可接受。
- **真实角色体系**：v1 `User.role` 默认 `admin`；多租户角色分配留后续。
