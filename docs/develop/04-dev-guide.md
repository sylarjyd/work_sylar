# AI 办公智能体 · 代码开发文档（含项目代码结构）

- 版本：v1.0
- 日期：2026-10-16
- 状态：随 M2 交付更新
- 关联：`docs/design/03-detailed-design.md`、`docs/develop/05-dev-plan.md`

本文件面向**新加入的开发者**，说明仓库结构、开发环境、分层约定、常见开发任务的做法与测试规范。

---

## 1. 技术栈与工具链

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22（本项目实测 22.13.1） | ESM，顶层 await 可用 |
| 包管理 | pnpm 10.19.0 | monorepo workspace |
| 任务编排 | Turborepo 2 | 并行 dev、依赖感知 build/test |
| 语言 | TypeScript 5.6（strict） | 统一配置 `tsconfig.base.json` |
| 测试 | Vitest 2 | 各包 `vitest run` |
| 构建 | tsup（shared/runtime）、nest build（bff）、next build（web） | — |

---

## 2. 仓库结构

```
work_sylar/
├─ package.json                # 根：pnpm workspace + turbo 脚本
├─ pnpm-workspace.yaml         # workspace 定义 + onlyBuiltDependencies（pnpm 10 必需）
├─ turbo.json                  # 任务图 + globalPassThroughEnv（所有 .env 变量）
├─ tsconfig.base.json          # 共享 TS 编译配置（strict）
├─ .env.example                # 环境变量模板（复制为 .env）
├─ docs/
│  ├─ design/                  # 概要/架构/详细设计
│  ├─ develop/                 # 本开发文档 + 开发计划
│  ├─ deploy/                  # 部署文档
│  ├─ db/schema.sql            # 数据库 DDL（与 Prisma 对齐）
│  └─ superpowers/             # 上游设计文档与各里程碑 spec/plan
├─ packages/
│  └─ shared/                  # @ai-office/shared：跨层契约（协议 + DTO）
└─ apps/
   ├─ agent-runtime/           # @ai-office/agent-runtime：Agent 引擎
   ├─ bff/                      # @ai-office/bff：NestJS 应用服务
   └─ web/                      # @ai-office/web：Next.js 网页端
```

### 2.1 `packages/shared`

```
packages/shared/
├─ package.json                # ESM 包；build=tsup(--dts)，exports 指向 dist
├─ tsconfig.json
└─ src/
   ├─ index.ts                 # 再导出 protocol + dto
   ├─ protocol.ts              # SSE 事件名/StepType/AgentEvent + 编解码/解析器
   ├─ protocol.test.ts         # 编解码与分片解析测试
   └─ dto.ts                   # 全部跨层 DTO 与请求/响应类型
```

**职责**：跨层类型的唯一来源；不依赖任何 app。

### 2.2 `apps/agent-runtime`

```
apps/agent-runtime/
├─ package.json                # dev=tsx watch；build=tsup；start=node dist/server.js
├─ tsconfig.json
└─ src/
   ├─ server.ts                # HTTP 服务：/health、/runs(SSE)；入口块 loadRootEnv+bucket
   ├─ server.test.ts
   ├─ agent-loop.ts            # plan→act→observe 主循环
   ├─ agent-loop.test.ts
   ├─ load-env.ts              # 读取仓库根 .env
   ├─ model/
   │  ├─ types.ts              # ModelGateway / ChatRequest / ChatResponse / ModelMessage
   │  ├─ create-gateway.ts     # 按 env 选真模型或 Mock
   │  ├─ create-gateway.test.ts
   │  ├─ openai-compat.ts      # OpenAI 兼容网关（函数名转换、多轮 tool 字段）
   │  ├─ openai-compat.test.ts
   │  └─ mock-gateway.ts       # 无 key 的确定性回退
   ├─ storage/
   │  ├─ s3.ts                 # S3/MinIO 封装：ensureBucket/putObject/getObjectStream
   │  └─ s3.test.ts
   └─ tools/
      ├─ types.ts              # RunContext + Tool 契约
      ├─ registry.ts           # createTools：组装内置工具集
      ├─ registry.test.ts
      ├─ web-search.ts         # web.search（Tavily / DuckDuckGo）
      ├─ web-search.test.ts
      ├─ web-fetch.ts          # web.fetch（SSRF 防护）
      ├─ web-fetch.test.ts
      ├─ doc.ts                # doc.docx/xlsx/pptx；safeFilename/artifactKey/emit
      ├─ doc.test.ts
      ├─ doc-generators.ts     # 纯函数：JSON → Buffer（docx/exceljs/pptxgenjs）
      └─ doc-generators.test.ts
```

**职责**：Agent 引擎（Loop + 工具 + 模型网关 + 对象存储写入）。不处理账号/多租户业务。

### 2.3 `apps/bff`

```
apps/bff/
├─ package.json                # dev=nest start --watch；build=nest build；db:* 脚本
├─ nest-cli.json
├─ docker-compose.yml          # Postgres 16 + MinIO（本地依赖）
├─ prisma/schema.prisma        # 数据模型（见 §6）
└─ src/
   ├─ main.ts                  # 引导：loadRootEnv→create→CORS→listen
   ├─ app.module.ts            # 模块装配
   ├─ cors.ts                  # CORS_OPTIONS（main 与测试共用）
   ├─ load-env.ts
   ├─ db/
   │  ├─ prisma.module.ts
   │  └─ prisma.service.ts     # PrismaClient + connect/disconnect
   ├─ auth/
   │  ├─ jwt.ts                # sign/verify + secret()
   │  ├─ jwt.guard.ts          # Bearer 校验
   │  ├─ current-user.ts       # @CurrentUser()
   │  ├─ auth.service.ts       # register/login（argon2 + 建租户）
   │  ├─ auth.controller.ts
   │  └─ *.test.ts
   ├─ sessions/
   │  ├─ sessions.service.ts   # list/create/assertOwned/messages
   │  ├─ sessions.controller.ts
   │  └─ sessions.controller.test.ts
   ├─ tasks/
   │  ├─ tasks.service.ts      # prepare/recordStep/finish
   │  ├─ tasks.controller.ts   # SSE 转发 + 落库（核心）
   │  └─ tasks.controller.test.ts
   ├─ artifacts/
   │  ├─ storage.ts            # ARTIFACT_STORAGE + createArtifactStorage
   │  ├─ artifacts.service.ts  # record/list/getForDownload + assertValidRef
   │  ├─ artifacts.controller.ts
   │  └─ *.test.ts
   └─ stream/
      └─ sse-proxy.ts          # writeHead（hijack 后显式写响应头）
```

**职责**：面向前端的应用服务（认证/多租户/会话/任务编排入口/SSE 网关/产物元数据与下载代理）。

### 2.4 `apps/web`

```
apps/web/
├─ package.json                # dev=next dev -p 3000；build；start
├─ next-env.d.ts
└─ src/
   ├─ app/
   │  ├─ layout.tsx            # 根布局（lang=zh-CN）
   │  ├─ page.tsx              # 工作台（目标输入 + 事件流 + 成果区）
   │  └─ login/page.tsx        # 登录/注册
   └─ lib/
      ├─ api.ts                # BFF 调用封装（令牌、401 处理、下载）
      ├─ sse-parser.ts         # 复用 shared 解析器
      ├─ render-step.ts        # AgentEvent → 文本
      └─ *.test.ts
```

---

## 3. 环境准备与常用命令

### 3.1 首次准备

```bash
pnpm install                                   # 安装依赖（pnpm 10 需放行构建脚本，见 workspace.yaml）
cp .env.example .env                           # 填 DEEPSEEK_API_KEY（缺省走 Mock）
pnpm --filter @ai-office/bff db:up             # docker compose 起 Postgres + MinIO
pnpm --filter @ai-office/bff db:push           # 同步表结构到数据库
```

### 3.2 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行启动 runtime(4001)/bff(4000)/web(3000) |
| `pnpm build` | 全量构建（turbo，依赖感知） |
| `pnpm test` | 全量测试 |
| `pnpm --filter @ai-office/bff test` | 仅 bff 测试 |
| `pnpm --filter @ai-office/bff typecheck` | 仅 bff 类型检查 |
| `pnpm --filter @ai-office/agent-runtime typecheck` | 仅 runtime 类型检查 |
| `pnpm --filter @ai-office/bff db:up` / `db:push` / `db:generate` | 基础设施与 Prisma |

> **改 `.env` 后必须重启 bff 与 runtime**：两者仅在启动时加载一次根 `.env`（`process.loadEnvFile`）。

---

## 4. 编码规范与约定

### 4.1 TypeScript

- `strict: true`；不滥用 `any`，跨进程 payload 用 `Record<string, unknown>` + 显式校验。
- 跨层类型**只在 `@ai-office/shared` 定义**，禁止各处重复声明。
- 模块级别名走 `@ai-office/shared`（workspace 依赖），不走相对路径跨包。

### 4.2 依赖方向（不可违反）

```
web ──▶ shared
bff ──▶ shared
runtime ──▶ shared
（shared 不依赖任何 app）
```

### 4.3 注释规范

- **默认不写注释**；仅在「为什么」不显然时写：隐藏约束、微妙不变量、针对特定 bug 的绕过、会令读者意外的行为。
- 不写「这段代码做什么」——好命名已表达；不写「本任务/某次修复」——那属于提交信息。
- 反例/正例（摘自本仓库既有风格）：`// 只有「桶不存在」才补建；鉴权/网络等错误直接冒泡，避免用 CreateBucket 掩盖真实原因。`

### 4.4 提交信息（**强制中文**）

- 格式：`type(scope): 中文摘要`；正文说明**为什么改**，不罗列改动。
- `type`：`feat` / `fix` / `docs` / `test` / `chore` / `refactor`。
- 示例：`fix(bff): 下载补齐会话归属校验并对齐响应头清洗`
- **不要擅自提交**：仅在用户明确要求时提交；除非用户另有指示，不执行 `amend` 等破坏性 git 操作。
- **绝不提交**机密文件与游离的无关文件（如仓库根 `任务.txt`）；始终用显式路径 `git add <file>`。

### 4.5 分层约定

- **BFF 不跑 Agent**、不经手大文件字节；**runtime 不碰账号/多租户**。
- 跨进程输入一律视为不可信：runtime 的产物引用、模型的 filename/URL 必须校验。
- 边界校验（用户输入）在 BFF 做；框架内部调用信任不变量，不做冗余防御。

---

## 5. 常见开发任务

### 5.1 新增一个工具（runtime）

以新增 `doc.markdown` 为例（**TDD**）：

1. **契约**：若需新产物类型，先在 `packages/shared/src/dto.ts` 扩展 `ArtifactKind`。
2. **纯函数**：在 `src/tools/doc-generators.ts` 加 `buildMarkdown(input): Promise<Buffer>`，并写 `doc-generators.test.ts` 反解断言。
3. **工具**：在 `src/tools/doc.ts` 的 `createDocTools` 追加：

```ts
{
  name: 'doc.markdown',
  description: '生成 Markdown 文档，返回产出物引用。',
  parameters: {
    type: 'object',
    properties: { filename: { type: 'string' }, content: { type: 'string' } },
    required: ['filename', 'content'],
  },
  async execute(args, ctx) {
    const filename = str(args, 'filename');           // 缺失 → missing_filename
    const content = str(args, 'content');             // 缺失 → missing_content
    const bytes = await buildMarkdown({ content });
    return emit(storage, ctx, 'markdown', filename, bytes);  // Key 前缀 + 上传 + ArtifactRef
  },
}
```

4. **接线**：`registry.ts` 的 `createTools` 已含 `...createDocTools(storage)`，无需改动。
5. **测试**：`tools/doc.test.ts` 注入假 storage，断言返回 `ArtifactRef` 与 `storageKey` 前缀含 `tenantId/runId`。
6. **`emit` 与校验复用**：`emit` 已统一「清洗文件名 → 拼 Key → 上传 → 返回引用」；新工具务必复用，不要另起炉灶。
7. 提交：`feat(runtime): 增加 doc.markdown 工具`。

> 若工具返回 `{artifact: ...}`，`agent-loop` 会自动补发 `artifact` step，BFF 会自动落库——无需改 Loop 或 BFF。

### 5.2 新增一个 BFF 接口

以新增「删除会话」`DELETE /api/sessions/:id` 为例：

1. **Service**：在 `sessions.service.ts` 加 `remove(sessionId, tenantId, userId)`，先 `assertOwned`，再 `prisma.session.delete`。
2. **Controller**：在 `sessions.controller.ts` 加方法，`@UseGuards(JwtGuard)`（类级已加），以 `@CurrentUser()` 取 `{tenantId, sub}`。
3. **DTO**：若返回结构新，先在 `shared/dto.ts` 定义。
4. **测试**：`sessions.controller.test.ts` 增测「未鉴权 401 / 越权 404 / 正常 200」，用假 Prisma。
5. 提交：`feat(bff): 增加删除会话接口`。

**红线**：

- 一律带 `tenantId`，并逐查询做归属校验（越权回 404，不泄露存在性）。
- 若接口要 hijack（如 SSE），**归属校验与建资源必须早于 `reply.hijack()`**，否则异常过滤器无法写响应、请求会挂起。

### 5.3 新增一个 Web 页面/交互

1. 在 `src/app/` 下建路由（App Router）。
2. BFF 调用封装进 `src/lib/api.ts`（统一走 `authFetch` 处理令牌与 401）。
3. 可测的纯逻辑（如 `render-step.ts`）抽到 `src/lib/` 并写单测。

### 5.4 修改数据模型

1. 改 `apps/bff/prisma/schema.prisma`。
2. 本地同步：`pnpm --filter @ai-office/bff db:push`（开发）；**生产用迁移**（见部署文档）。
3. 同步更新 `docs/db/schema.sql` 与详细设计文档。
4. 涉及跨层字段（如产物）时同步 `shared/dto.ts`。

---

## 6. 数据模型（Prisma 速览）

模型：`Tenant` / `User` / `Session` / `Message` / `Task` / `Run` / `Step` / `Artifact`。唯一约束：`User.email`、`Message(sessionId,seq)`、`Step(runId,seq)`。索引：`User(tenantId)`、`Session(tenantId,userId)`、`Task(sessionId)`、`Run(taskId)`、`Artifact(sessionId)`、`Artifact(tenantId)`。

字段语义与关系详见详细设计 §E，DDL 详见 `docs/db/schema.sql`。

---

## 7. 测试规范

### 7.1 原则

- **TDD**：先写失败测试，再实现，最后重构。
- **非真空测试**：断言必须能因「实现被回退」而失败。反例：只断言「客户端没挂起」——而框架兜底也会 end 响应，用例恒真。正例：断言「异常没有冒泡出控制器」（见 `tasks.controller.test.ts` 的 `RecordingExceptionFilter`）。
- **离线可跑**：网络/DNS/S3/模型均以可注入替身替代，测试不依赖外部服务。
- **用例隔离**：模块级共享状态（如 `stored`）在 `beforeEach` 清空，避免顺序依赖导致的假阳性。

### 7.2 覆盖重点

| 层 | 重点 |
|---|---|
| shared | 编解码对称、跨分片解析、非法帧返回 null |
| runtime | Loop 事件序列（含 `artifact` 补发）、工具参数校验与 Key 前缀、SSRF 判定、文档生成内容反解、`ensureBucket` 幂等 |
| bff | 鉴权 401、越权 404、SSE 落库、上游故障落 failed、下载头清洗与流回收、`assertValidRef` 校验 |
| web | api 令牌/401、render-step 文案、SSE 解析 |

### 7.3 运行

```bash
pnpm test                                          # 全部
pnpm --filter @ai-office/bff test                  # 单包
pnpm --filter @ai-office/bff typecheck             # 类型
```

---

## 8. 调试与常见问题

| 现象 | 排查 |
|---|---|
| `ensureBucket 失败` | 对象存储未就绪或 `.env` 缺 `S3_*`；文档工具会在运行期报错 |
| 下载 502 `object_unavailable` | BFF 的 `.env` 未含 S3 凭证，或对象缺失；**改 `.env` 需重启 bff** |
| Agent 只调 `web.search`、不生成文档 | 走了 Mock（`DEEPSEEK_API_KEY` 为空）；填真 key 并重启 runtime |
| 前端 SSE 无事件 | 确认 `NEXT_PUBLIC_BFF_URL`；确认 BFF 正常返回 `text/event-stream` |
| 改 `.env` 不生效 | bff/runtime 仅在启动时加载一次根 `.env`，需重启 |
| Windows 下 `taskkill /PID` 报路径错 | Git Bash 的 MSYS 路径转换所致，用 `MSYS_NO_PATHCONV=1 taskkill /PID <pid> /T /F` |

---

## 9. 安全红线（开发时）

1. 任何数据库查询都必须携带并校验 `tenantId`。
2. 不信任跨进程输入（runtime payload、模型给的 filename/URL）。
3. 密码只存 argon2 哈希；令牌只走 `Authorization` 头。
4. `web.fetch` 等对外请求必须防 SSRF（校验全部解析地址 + 固定连接 IP + 不跟随跳转）。
5. 文件名进出 HTTP 头必须清洗（控制字符、引号、反斜杠）。
6. `.env` 永不提交；生产密钥由环境注入。

---

## 10. 计费模块（M5a）本地开发

1. `pnpm --filter @ai-office/bff db:up`（Postgres + MinIO + Redis）。
2. `pnpm --filter @ai-office/bff db:push && pnpm --filter @ai-office/bff db:seed:billing`。
3. 注册账号后自动获得 free 套餐 500 积分。
4. 无 `DEEPSEEK_API_KEY` 时 runtime 走 mock 模型，仍会产出 usage，可完整验证结算链路。
5. 模拟管理员操作：先把账号提权 `pnpm --filter @ai-office/bff admin:promote <email>`，再调 `/api/billing/admin/*`。
