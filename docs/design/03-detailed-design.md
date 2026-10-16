# AI 办公智能体 · 详细设计（Detailed Design）

- 版本：v1.0
- 日期：2026-10-16
- 状态：随 M2 交付更新
- 关联：`docs/design/01-overview-design.md`、`docs/design/02-architecture.md`、`docs/db/schema.sql`

> 本文逐一描述**各模块的职责、接口签名、关键算法、错误处理与边界条件**，与当前代码一一对应。

---

## 目录

- [A. 共享契约层 `packages/shared`](#a-共享契约层-packages-shared)
- [B. Agent 运行时 `apps/agent-runtime`](#b-agent-运行时-apps-agent-runtime)
- [C. BFF 应用服务 `apps/bff`](#c-bff-应用服务-apps-bff)
- [D. Web 前端 `apps/web`](#d-web-前端-apps-web)
- [E. 数据模型详解](#e-数据模型详解)
- [F. 配置项详解](#f-配置项详解)

---

## A. 共享契约层 `packages/shared`

跨层类型与协议的**唯一来源**，被 web / bff / runtime 共同依赖。构建产物为 ESM + `.d.ts`。

### A.1 `src/protocol.ts` —— SSE 编解码

| 导出 | 签名 | 说明 |
|---|---|---|
| `SSE_EVENT_NAMES` | `readonly ['step','usage','done','error']` | 合法事件名 |
| `StepType` | `'think'\|'tool_call'\|'tool_result'\|'artifact'` | 步类型 |
| `AgentEvent` | `{runId, seq, type, payload, ts}` | 单步事件 |
| `SseMessage<T>` | `{event: SseEventName, data: T}` | 一条消息 |
| `encodeSse(msg)` | `(SseMessage<T>) => string` | 编码为 `event:..\ndata:..\n\n` |
| `parseSseFrame(frame)` | `(string) => SseMessage \| null` | 解析单帧；空帧/缺字段/非法事件名/非法 JSON 返回 `null`（不抛） |
| `decodeSseFrames(text)` | `(string) => SseMessage[]` | 解析已累积文本的**全部完整帧**；末尾未以 `\n\n` 终止的残段丢弃 |
| `createSseParser()` | `() => (chunk: string) => SseMessage[]` | **有状态**解析器，跨网络分片逐个产出完整事件 |

**关键算法（`createSseParser`）**：维护内部 `buffer`；每次追加 chunk 后，循环 `indexOf('\n\n')` 切出完整帧、解析、前移缓冲；残段留在缓冲等待下一分片。BFF 与 Web 共用此实现，杜绝协议漂移。

### A.2 `src/dto.ts` —— 数据契约

| 导出 | 说明 |
|---|---|
| `ChatRole` | `'system'\|'user'\|'assistant'\|'tool'` |
| `ChatMessage` | `{role, content}`（持久化历史用） |
| `RunRequest` | web→bff→runtime 的「下达目标」请求（含 `tenantId`） |
| `RegisterRequest` / `LoginRequest` | `{email, password}` |
| `AuthUser` / `AuthResponse` | `{id,email}` / `{token, user}` |
| `CreateSessionRequest` | `{title?}` |
| `SessionSummary` | `{id, title, createdAt(ISO)}` |
| `MessageDto` | `{id, role, content, seq}` |
| `CreateTaskRequest` | `{goal}` |
| `ArtifactKind` | `'docx'\|'xlsx'\|'pptx'` |
| `ArtifactRef` | `{kind, filename, storageKey, size}`；`artifact` step 的 payload |
| `ArtifactDto` | `{id, kind, filename, size, version, createdAt(ISO)}` |

### A.3 `src/index.ts`

`export * from './protocol'; export * from './dto';`

---

## B. Agent 运行时 `apps/agent-runtime`

独立 Node 服务，ESM。入口 `src/server.ts`。

### B.1 `src/server.ts` —— HTTP 服务

**`createRuntimeServer(deps?: RuntimeDeps): Server`**

```ts
interface RuntimeDeps {
  gateway?: ModelGateway;   // 默认 createGateway()
  tools?: Tool[];           // 默认 createTools(process.env, storage)
  storage?: Storage;        // 默认 createStorage()
}
```

路由：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/health` | `200 {ok:true}` |
| POST | `/runs` | 见下 |
| * | * | `404 {error:'not found'}` |

**`POST /runs` 处理逻辑**：

1. **鉴权**：若设 `AGENT_RUNTIME_TOKEN`，校验请求头 `x-agent-runtime-token`；不匹配 → `401 {error:'unauthorized'}`。
2. **解析体**：累积 body，`JSON.parse`；失败 → `400 {error:'invalid json'}`。
3. **开流**：`200 text/event-stream, cache-control:no-cache, connection:keep-alive`。
4. **执行**：异步迭代 `runAgent(runReq, {gateway, tools, onUsage})`，每事件写 `event: step`；`onUsage` 写 `event: usage`；结束写 `event: done {runId}`；异常写 `event: error {message}`；`finally` 关闭响应。

**入口块（`isEntry`）**：`loadRootEnv()` → `createStorage()` → `ensureBucket()`（失败仅告警，运行期文档工具会报错）→ 监听 `AGENT_RUNTIME_HOST`（默认 `127.0.0.1`）与 `AGENT_RUNTIME_PORT`（默认 `4001`）。

### B.2 `src/agent-loop.ts` —— Agent Loop

**`runAgent(req: RunRequest, deps: RunDeps): AsyncGenerator<AgentEvent>`**

```ts
interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;                              // 默认 8
  onUsage?: (u: {input: number; output: number}) => void;
}
```

**算法**：

1. 组装工具 schema 列表；构造 `RunContext{tenantId, sessionId, runId}`。
2. 循环至多 `maxRounds` 轮：
   - `resp = gateway.chat({messages, tools: schemas})`；累加 usage。
   - 若 `resp.content` → `yield step('think', {text})`。
   - 若无 toolCalls → 回填最终 assistant 文本，`break`。
   - 若有 toolCalls → 推入带回 `toolCalls` 的 assistant 消息；逐个：
     - `yield step('tool_call', {tool, args})`。
     - `tool = tools.find(name)`；`try { result = await tool.execute(args, ctx) } catch { ok=false; result={error} }`。
     - `yield step('tool_result', {tool, ok, preview})`（`preview` 超 500 字符截断）。
     - 若成功且结果含 `artifact` 字段 → `yield step('artifact', ref)`。
     - 结果以 `role:'tool'`、`toolCallId` 回填，`content` 截断至 4000 字符。
3. 循环结束调 `onUsage?.(usage)`。

**边界**：`extractArtifact` 只在结果对象含非数组对象字段 `artifact` 时取值；`seq` 单调递增（0 起）；`ts = Date.now()`。

> 注：耗尽 `maxRounds` 会静默结束（客户端只看到 `done`）；「轮次耗尽」信号留待后续里程碑，不新增事件、不改变输出契约。

### B.3 `src/tools/types.ts` —— 工具契约

```ts
interface RunContext { tenantId: string; sessionId: string; runId: string; }
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON-Schema，喂给模型做 function-calling
  execute(args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}
```

> 工具集在**启动期构建一次**、跨 run 共享；单次运行信息通过 `ctx` 运行期注入。

### B.4 `src/tools/registry.ts` —— 工具注册表

**`createTools(env = process.env, storage = createStorage(env)): Tool[]`** → `[web.search, web.fetch, doc.docx, doc.xlsx, doc.pptx]`。

### B.5 `src/tools/web-search.ts` —— 联网搜索

| 导出 | 说明 |
|---|---|
| `SearchResult` | `{title, url, snippet}` |
| `SearchProvider` | `search(query) => Promise<SearchResult[]>` |
| `createSearchProvider(env)` | 有 `TAVILY_API_KEY` → Tavily；否则 DuckDuckGo 免 key 回退 |
| `createWebSearchTool(provider)` | 工具 `web.search` |

- 入参 `{query: string}`；空则 `missing_query`。
- 超时 `15s`（`AbortSignal.timeout`）；HTTP 非 2xx → `tavily_http_<status>` / `ddg_http_<status>`；JSON 解析失败 → `*_bad_json`。
- Tavily 取 `max_results:5`；DuckDuckGo 取 instant answer + RelatedTopics，截断 5 条。

### B.6 `src/tools/web-fetch.ts` —— 网页抓取（SSRF 防护）

| 导出 | 说明 |
|---|---|
| `isBlockedIp(ip)` | 判定环回/私网/链路本地/ULA/保留/组播等非公网地址 |
| `pinnedLookup(ip, family?)` | 返回兼容 node 三种调用形式的 lookup，把连接固定到已校验 IP |
| `requestPinned` | 默认 Transport：node:http(s) GET，`lookup=pinnedLookup`，不跟随跳转 |
| `htmlToText(html)` | 极简 HTML→文本（去 script/style、去标签、压缩空白、解码实体） |
| `createWebFetchTool(resolve?, transport?)` | 工具 `web.fetch`（依赖可注入，便于离线单测） |

**`execute` 算法**：

1. `new URL(raw)`，非 `http/https` → `invalid_url`。
2. `addrs = await resolve(url.hostname)`；`addrs` 为空或**任一** `isBlockedIp` → `blocked_host`。
3. `transport(url, addrs[0], 15000)`；3xx → `redirect_blocked`；非 2xx → `fetch_http_<status>`。
4. `htmlToText(body)`，返回 `{url, text(≤8000), truncated}`。

**安全要点**：解析主机名**全部** A/AAAA 记录（只查一条会漏掉混入的内网地址）；连接固定到已校验 IP（消除 DNS rebinding TOCTOU）；不跟随跳转（防重定向绕过）。

### B.7 `src/tools/doc-generators.ts` —— 文档生成纯函数

| 函数 | 输入 | 输出 |
|---|---|---|
| `buildDocx(input)` | `{title?, sections:[{heading?, paragraphs[]}]}` | `Promise<Buffer>` |
| `buildXlsx(input)` | `{sheets:[{name, rows:(string\|number)[][]}]}` | `Promise<Buffer>` |
| `buildPptx(input)` | `{slides:[{title?, bullets[]}]}` | `Promise<Buffer>` |

纯函数（输入 JSON → Buffer），与上传解耦，便于单测反解字节断言内容。依赖 `docx` / `exceljs` / `pptxgenjs`。

### B.8 `src/tools/doc.ts` —— 文档工具

| 导出 | 说明 |
|---|---|
| `safeFilename(name)` | 去控制字符（含 CR/LF，防头注入）、`\`/`/`→`_`、`..`→`_`、trim；空则 `artifact` |
| `artifactKey(ctx, filename)` | `artifacts/{tenantId}/{runId}/{uuid}-{safeFilename}` |
| `createDocTools(storage)` | 三工具 `doc.docx` / `doc.xlsx` / `doc.pptx` |

**统一 `emit` 流程**：`safeFilename` → `artifactKey` → `storage.putObject(key, bytes, MIME)` → 返回 `{artifact: {kind, filename(清洗后), storageKey, size}}`。

**入参与校验**：

| 工具 | 必填 | 缺失错误 |
|---|---|---|
| `doc.docx` | `filename`, `sections[]` | `missing_filename` / `missing_sections` |
| `doc.xlsx` | `filename`, `sheets[]` | `missing_filename` / `missing_sheets` |
| `doc.pptx` | `filename`, `slides[]` | `missing_filename` / `missing_slides` |

MIME 映射：docx/xlsx/pptx 对应 OOXML 类型。

### B.9 `src/storage/s3.ts` —— 对象存储封装

```ts
interface Storage {
  ensureBucket(): Promise<void>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObjectStream(key: string): Promise<Readable>;
}
```

- `createS3Client(env)`：`endpoint/region/凭证` 取自 env，**`forcePathStyle: true`**（MinIO 需 path-style）。
- `createStorage(env, client)`：`bucket = env.S3_BUCKET ?? 'artifacts'`。
- **`ensureBucket`**：`HeadBucket` 成功即返回；仅当「桶不存在」（404 / `NotFound` / `NoSuchBucket`）才 `CreateBucket`；并发下 `BucketAlreadyOwnedByYou`/`BucketAlreadyExists` 视为幂等成功；**其他错误（鉴权/网络）直接冒泡**，不用 `CreateBucket` 掩盖。
- `S3Sender` 抽象便于单测注入假 client。

### B.10 `src/model/*` —— 模型网关

| 文件 | 内容 |
|---|---|
| `types.ts` | `ToolSchema`/`ToolCall`/`ModelMessage`（含 `toolCalls`/`toolCallId`）/`ChatRequest`/`ChatResponse`/`ModelGateway` |
| `create-gateway.ts` | `createGateway(env)`：有 `DEEPSEEK_API_KEY` → `OpenAICompatGateway`；否则 `MockGateway` |
| `openai-compat.ts` | `OpenAICompatGateway`：走 `/chat/completions` |
| `mock-gateway.ts` | `MockGateway`：确定性回退（首轮 `web.search`，次轮给结论） |

**`OpenAICompatGateway` 要点**：

- **函数名转换**：provider 只允许 `^[a-zA-Z0-9_-]+$`，点号会被 400 拒绝；`web.search` → wire 名 `web_search`（`toWireName`），并用反向表把 provider 回传名还原为逻辑名（未命中则原样透传）。
- **多轮 function-calling**：assistant 消息回带 `tool_calls`、tool 消息回带 `tool_call_id`，否则真实 provider 会被拒（400）。
- 非 2xx → `model_http_<status>`；JSON 解析失败 → `model_bad_json`；`arguments` 非法 JSON 时安全解析为 `{}`。

### B.11 `src/load-env.ts`

`loadRootEnv()`：读 `resolve(process.cwd(), '../../.env')`，存在则 `process.loadEnvFile(root)`；缺失静默跳过（CI/生产由真实环境变量注入）。

> **注意**：`process.loadEnvFile` **不覆盖**已存在的环境变量（shell env 优先）。改 `.env` 后需重启进程才生效。

---

## C. BFF 应用服务 `apps/bff`

NestJS + Fastify。入口 `src/main.ts`。

### C.1 `src/main.ts`

`loadRootEnv()`（**必须在 `NestFactory.create` 之前**，因 Prisma 连接串、JWT 密钥在实例化服务时读取）→ `NestFactory.create(AppModule, new FastifyAdapter())` → `enableCors(CORS_OPTIONS)` → 监听 `PORT`（默认 4000，`0.0.0.0`）。

### C.2 `src/app.module.ts`

导入 `PrismaModule`；控制器 `Auth/Sessions/Tasks/Artifact`；Provider 含 `AuthService`/`SessionsService`/`TasksService`/`ArtifactService` 与 `{provide: ARTIFACT_STORAGE, useFactory: createArtifactStorage}`。

### C.3 认证模块 `src/auth`

| 文件 | 内容 |
|---|---|
| `jwt.ts` | `JwtPayload{sub,tenantId}`；`signToken`（HS256，7d）/`verifyToken`；`secret()` **每次调用读 env**（测试在 beforeAll 设 `JWT_SECRET`），未设则抛错 |
| `jwt.guard.ts` | `JwtGuard`：解析 `Authorization: Bearer <token>`；缺/错 → `401`；成功写 `req.user` |
| `current-user.ts` | `@CurrentUser()` 参数装饰器，取 `req.user` |
| `auth.controller.ts` | `POST /api/auth/register`、`POST /api/auth/login`（`@HttpCode(200)`） |
| `auth.service.ts` | `register` / `login` |

**`AuthService` 要点**：

- `register`：邮箱已存在 → `409 email_taken`；`argon2.hash` 密码；**建 User 时内联建 `personal` 租户**（为多租户预留）；签发令牌。
- `login`：邮箱不存在与密码错误**返回同一错误** `401 invalid_credentials`（防账号枚举）。
- `issue`：`signToken({sub: userId, tenantId})`。

### C.4 会话模块 `src/sessions`

| 文件 | 内容 |
|---|---|
| `sessions.controller.ts` | `GET /api/sessions`（list）、`POST /api/sessions`（create）、`GET /api/sessions/:id/messages` |
| `sessions.service.ts` | `list` / `create` / `assertOwned` / `messages` |

- 全部带 `@UseGuards(JwtGuard)`，以 `user.tenantId` / `user.sub` 做行级隔离。
- `assertOwned(sessionId, tenantId, userId)`：`findFirst({id,tenantId,userId})`，无则 `404 session_not_found`（不泄露存在性）。
- `messages`：先 `assertOwned`，再按 `seq` 升序返回。

### C.5 任务模块 `src/tasks`

#### `tasks.service.ts`

| 方法 | 说明 |
|---|---|
| `prepare(sessionId, tenantId, userId, goal)` | `assertOwned` → 查历史消息 → 建 Task(running) + Run(running) → 落 user 消息(seq=历史条数) → 返回 `{taskId, runId, tenantId, messages}`（含历史 + 本次 goal） |
| `recordStep(runId, ev)` | 落 `step`（`seq`/`type`/`payload`） |
| `finish(runId, taskId, status, assistantText, sessionId)` | Run 置 status + endedAt；Task 置 status；若 `assistantText` 非空则落 assistant 消息（`seq = count`） |

#### `tasks.controller.ts`（核心）

**`POST /api/sessions/:id/tasks`**，`@Res() reply: FastifyReply`：

1. **边界校验**：`goal` 非空字符串，否则 `400 {error:'invalid_goal'}`（此时未建 task/run、未 hijack）。
2. **归属校验 + 建 task/run**：`tasks.prepare(...)`（可能抛 `NotFoundException`）—— **必须早于 hijack**。
3. **`reply.hijack()`**：本方法直写 `reply.raw`，须 hijack 否则 Nest 会再发一次响应。
4. **断连处理**：`clientGone` 标志 + `reader`；`reply.raw.on('error'|'close', onClientGone)`（socket error 无监听会崩进程）。
5. **发起上游**：`fetch(${runtimeUrl}/runs)`，带可选 `x-agent-runtime-token`，body 为 `RunRequest`。
   - 传输层异常 → `safeFinish(failed)` + `502 {error:'upstream_unreachable'}`。
   - 非 2xx / 无 body → `safeFinish(failed)` + 原样转发状态码与响应体。
6. **正常流**：`writeHead(200, text/event-stream, no-cache, keep-alive)`；`createSseParser()` + `reader`；
   - 循环：若 `clientGone` → `reader.cancel()` + `break`；读块 → 原样 `reply.raw.write(chunk)` → 解析事件：
     - `step`：`think` 累积文本；`recordStep`；若 `type==='artifact'` → `safeRecordArtifact`。
     - `error`：`status='failed'`。
   - 循环任何异常 → `status='failed'` + 记日志。
   - `finally`：`safeFinish(...)`（best-effort）+ **无条件** `reply.raw.end()`。

**辅助方法**：`safeRecordArtifact` / `safeFinish` 均 try/catch 只记日志，绝不抛出（否则阻断响应终止）。

### C.6 产物模块 `src/artifacts`

| 文件 | 内容 |
|---|---|
| `storage.ts` | `ARTIFACT_STORAGE` 注入令牌；`ArtifactStorage{getObjectStream}`；`createArtifactStorage(env)`（S3Client，`forcePathStyle:true`，只读为主） |
| `artifacts.service.ts` | `record` / `list` / `getForDownload` |
| `artifacts.controller.ts` | `GET /api/sessions/:id/artifacts`、`GET /api/artifacts/:id/download` |

#### `ArtifactService`

- **`assertValidRef(ref, tenantId, runId)`**（私有，跨进程信任边界）：`filename` 非空字符串；`kind ∈ {docx,xlsx,pptx}`；`size` 为非负整数；`storageKey` 以 `artifacts/{tenantId}/{runId}/` 开头。任一不符抛错（由调用方吞掉并记日志）。
- `record(runId, sessionId, tenantId, ref)`：`assertValidRef` → `aggregate({sessionId, filename}, _max.version)` → `version = max+1` → `create`。
- `list(sessionId, tenantId, userId)`：`assertOwned` → `findMany({sessionId, tenantId})` 按 `createdAt` 倒序 → 映射 `ArtifactDto`。
- `getForDownload(id, tenantId, userId)`：`findFirst({id, tenantId})`，无 → `404`；再 `assertOwned(a.sessionId, tenantId, userId)`；`getObjectStream(a.storageKey)`。返回 `{filename, kind, stream}`。

#### `ArtifactController`

- `contentDisposition(filename)`（导出，便于单测）：ASCII 回退（非 ASCII→`_`、去 `"`/`\`）+ RFC 5987 `filename*=UTF-8''<encoded>`。
- `download`：`getForDownload` 异常 → `NotFound → 404`，否则 `502 {error:'object_unavailable'}`（DB 有行但对象缺失）；设 `content-type`（按 kind）+ `content-disposition`；`reply.raw.once('close', () => stream.destroy())`（客户端断连销毁上游流）；`await reply.send(stream)`。

### C.7 `src/stream/sse-proxy.ts`

`writeHead(reply, status, headers)`：hijack 后 Fastify 不再参与发送，中间件写入 `reply` 的响应头（CORS 等）不会自动落到 socket；此函数把已累积头取出与本次头合并后显式 `reply.raw.writeHead(...)`。

### C.8 `src/db/prisma.service.ts` / `prisma.module.ts`

`PrismaService extends PrismaClient`，`onModuleInit` `$connect()`、`onModuleDestroy` `$disconnect()`。

### C.9 `src/cors.ts` / `src/load-env.ts`

- `CORS_OPTIONS = {origin: true}`（开发态放行；main.ts 与测试共用，避免生产漏开 CORS）。生产应收敛白名单。
- `loadRootEnv()`：同 runtime。

---

## D. Web 前端 `apps/web`

Next.js App Router，客户端组件为主。

### D.1 `src/lib/api.ts`

| 导出 | 说明 |
|---|---|
| `getToken/setToken/clearToken` | `localStorage` 的 `ai_office_token` |
| `authFetch(path, init)` | 拼 `BFF_URL` + `Authorization`；**401 就地清 token 并抛 `unauthorized`** |
| `isUnauthorized(err)` | 判定上述错误 |
| `authErrorMessage(err)` | 把错误码映射为友好中文文案 |
| `register/login` | 直接 `fetch`，失败抛 `register_failed_<status>` / `login_failed_<status>` |
| `listSessions/createSession/streamTask/listArtifacts` | 走 `authFetch` |
| `downloadArtifact(id, filename)` | `fetch` 取 blob → `URL.createObjectURL` → 触发 `<a download>`；**延后一帧 revoke**（Safari/Firefox 异步读 blob，立即 revoke 会下载为空） |

> `BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000'`。

### D.2 `src/lib/render-step.ts`

`renderStep(ev)`：把 `AgentEvent` 渲染为人类可读文本（think/tool_call/tool_result/artifact）；未知类型渲染为空串（前向兼容）。

### D.3 `src/lib/sse-parser.ts`

复用 `@ai-office/shared` 的有状态解析器（薄封装）。

### D.4 `src/app/page.tsx`（工作台）

- 状态：`sessions / sessionId / goal / events / artifacts / running / error`。
- 挂载时无 token → 跳 `/login`；有 → 拉会话列表。
- `run()`：若无所选会话则先 `newSession()`；`streamTask` 增量解析 SSE，`step` 追加事件、`artifact` 即时追加乐观卡片；`error` 事件写 error；`finally` 统一 `refreshArtifacts`。
- **竞态规避**：跑流期间不刷新（新会话 `setSessionId` 会触发 effect，若并发拉取会覆盖乐观卡片）；`sessionId` 为 state，新建会话须用返回的 id 直发请求，不能用闭包里的旧值。
- 成果区：卡片显示 `文件名 / 类型 / 大小 / 版本 / 时间`；有 `id` 才可下载（`id` 为空表示落库中）。

### D.5 `src/app/login/page.tsx` / `layout.tsx`

登录/注册切换表单；`layout` 设 `lang="zh-CN"` 与基础样式。

---

## E. 数据模型详解

> DDL 见 `docs/db/schema.sql`；此处为字段语义与约束。

### E.1 `Tenant`

`id`(uuid)、`type`(默认 `personal`；预留 `org`)、`name`、`plan`(默认 `free`)、`createdAt`。关系：`users[]`、`sessions[]`。

### E.2 `User`

`id`(uuid)、`tenantId`、`email`(**唯一**)、`passwordHash`(argon2)、`status`(默认 `active`)、`createdAt`。`@@index([tenantId])`。

### E.3 `Session`

`id`(uuid)、`tenantId`、`userId`、`title`(默认「新会话」)、`status`(默认 `active`)、`createdAt`。`@@index([tenantId, userId])`。关系：`tenant`、`user`、`messages[]`、`tasks[]`、`artifacts[]`。

### E.4 `Message`

`id`(uuid)、`sessionId`、`role`、`content`、`seq`、`tokens?`、`createdAt`。**`@@unique([sessionId, seq])`**。

### E.5 `Task`

`id`(uuid)、`sessionId`、`goal`、`status`(默认 `queued`；运行中 `running`，收尾 `done`/`failed`)、`createdAt`。`@@index([sessionId])`。关系：`runs[]`。

### E.6 `Run`

`id`(uuid)、`taskId`、`status`(默认 `running`)、`startedAt`、`endedAt?`。`@@index([taskId])`。关系：`steps[]`、`artifacts[]`。

### E.7 `Step`

`id`(uuid)、`runId`、`seq`、`type`、`payload`(**Json**)、`ts`。**`@@unique([runId, seq])`**。

### E.8 `Artifact`

`id`(uuid)、`tenantId`、`sessionId`、`runId`、`kind`(`docx|xlsx|pptx`)、`filename`、`storageKey`、`size`(Int)、`version`(默认 1)、`createdAt`。`@@index([sessionId])`、`@@index([tenantId])`。关系：`session`、`run`。

**版本语义**：按 `(sessionId, filename)` 递增（落库时取 `max+1`）；同名文档重生成即升版。

> **已知风险**：`version` 无唯一约束，并发落库可能重号（见架构设计 §10）。

---

## F. 配置项详解

| 变量 | 默认 | 适用 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | — | bff | Prisma 连接串 |
| `JWT_SECRET` | — | bff | JWT 签名密钥（未设则抛错） |
| `DEEPSEEK_API_KEY` | 空 | runtime | 空则走 Mock Gateway |
| `MODEL_BASE_URL` | `https://api.deepseek.com/v1` | runtime | OpenAI 兼容基址 |
| `MODEL_NAME` | `deepseek-chat` | runtime | 模型名 |
| `TAVILY_API_KEY` | 空 | runtime | 空则 DuckDuckGo 回退 |
| `AGENT_RUNTIME_URL` | `http://localhost:4001` | bff | 上游 runtime 地址 |
| `AGENT_RUNTIME_TOKEN` | 空 | bff+runtime | 共享密钥；设置后 runtime 强制校验 |
| `AGENT_RUNTIME_HOST` | `127.0.0.1` | runtime | 监听地址（对外须改 `0.0.0.0` + 配 token） |
| `AGENT_RUNTIME_PORT` | `4001` | runtime | 监听端口 |
| `PORT` | `4000` | bff | BFF 端口 |
| `NEXT_PUBLIC_BFF_URL` | `http://localhost:4000` | web | 前端访问 BFF 的基址 |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | bff+runtime | 对象存储端点 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `minioadmin` | bff+runtime | 凭证 |
| `S3_BUCKET` | `artifacts` | bff+runtime | 桶名 |
| `S3_REGION` | `us-east-1` | bff+runtime | 区域（可选） |

> 全量见 `.env.example`；turbo 的 `globalPassThroughEnv` 已列出这些变量，确保子进程可见。
