# M2「会干活」· 文档生成与成果区 · 设计文档

- 日期：2026-10-16
- 状态：待用户审阅
- 关联：上游 `docs/superpowers/specs/2026-10-15-ai-office-agent-design.md` 第 5.2 / 6 / 8 节
- 前置：M1（账号 + 会话 + Agent Loop + 联网工具）已交付并端到端验证

## 1. 背景与目标

M1 让 Agent「会聊天、会联网查」。M2 让它「会干活」：**按用户目标生成 docx / xlsx / pptx 文档，落存储，用户可在网页成果区看到并下载**。

上游 v1 验收标准的核心动作——「下达目标 → 实时看 Agent 干活 → 下载到成果」——在本期首次闭环。

**目标**
- Agent 能用三个内置工具生成 Word / Excel / PPT。
- 产物落对象存储（MinIO，S3 兼容），元数据落 Postgres。
- 网页成果区：列出会话产物、显示元数据、下载。
- 沿用 M1 的三层解耦与 SSE 契约，`artifact` step 类型补上实现。

**非目标（本期明确不做）**
- 在线预览（docx/xlsx/pptx 预览留后续）。
- `file.*` 文件工作区工具、`code.exec` 沙箱执行（分别留 M3/M4）。
- 工具权限分级与确认卡片（M3 安全）。
- 多 Agent 派生、子 Agent 编排。

## 2. 已确认的关键决策

| 议题 | 决策 | 理由 |
|---|---|---|
| 范围边界 | 仅「文档生成 + 成果区」 | 与上游 M2 对齐；file.*/code.exec 归 M3/M4 |
| 产物存储 | 自建 MinIO（S3 兼容，docker） | 贴近生产；解耦 runtime/BFF 磁盘 |
| 字节流转 | runtime 直传 MinIO，BFF 只管元数据与鉴权下发 | 字节只落地一次，BFF 不经手大文件 |
| 预览保真 | 不做在线预览，仅「列表 + 下载 + 元数据」 | 先打通「产出→存储→下载」闭闭环，体量最小 |
| 工具粒度 | 三个工具 `doc.docx` / `doc.xlsx` / `doc.pptx` | 对齐上游 §5.2 |
| 下载鉴权 | BFF 代理 `GET /api/artifacts/:id/download` | MinIO 保持内网私有，租户校验收口一处 |
| 成果区位置 | 内嵌工作台页（非独立路由） | 与逐步渲染同屏，切会话即刷新，实现最简 |
| 版本 | `Artifact.version`，按 `(sessionId, filename)` 递增 | 同名文档重生成即升版 |

## 3. 架构与数据流

### 3.1 分层变更

- **基础设施**：`apps/bff/docker-compose.yml` 增 MinIO 服务（API 9000 / 控制台 9001），启动后预建 bucket `artifacts`。
- **shared**：`RunRequest` 增 `tenantId`；新增 `ArtifactRef` / `ArtifactDto`；`artifact` step 的 payload 定型为 `ArtifactRef`。
- **agent-runtime**：新增 `storage/s3.ts`（S3 客户端封装）；新增 `tools/doc.ts`（三工具）；`agent-loop` 检测工具结果里的 `artifact` 字段并额外 `yield` 一条 `artifact` step。
- **bff**：Prisma 增 `Artifact` 模型；新增 `artifacts` 模块（落库 + 列表 + 下载代理）；`tasks.controller` 转发时识别 `artifact` step 落库。
- **web**：工作台内嵌成果区（会话产物卡片 + 下载）。

### 3.2 一次「生成文档」的完整数据流

1. web `POST /api/sessions/:id/tasks`（goal）→ BFF 建 task/run。
2. BFF `POST /runs` 到 runtime，载荷带 `runId / sessionId / tenantId / goal / messages`。
3. runtime Agent Loop：模型决定调用 `doc.pptx` 等 → 工具用 `docx`/`exceljs`/`pptxgenjs` 生成字节 → `PUT artifacts/{tenantId}/{runId}/{uuid}-{filename}` 到 MinIO → 工具返回 `{ artifact: ArtifactRef }`。
4. `agent-loop` 见工具结果含 `artifact` → 除正常 `tool_result` 外，额外 `yield` 一条 `artifact` step。
5. BFF 透传 SSE，遇 `artifact` step → 落 `Artifact` 行（含 `version`）。
6. web 收 `artifact` step → 成果区即时追加卡片。
7. 下载：web `GET /api/artifacts/:id/download` → BFF 校验租户归属 → 从 MinIO 取流回传。

### 3.3 存储 Key 约定

```
artifacts/{tenantId}/{runId}/{uuid}-{filename}
```

按租户天然隔离，`uuid` 前缀杜绝重名覆盖。

## 4. 数据模型（Prisma 新增）

```prisma
model Artifact {
  id         String   @id @default(uuid())
  tenantId   String
  sessionId  String
  runId      String
  kind       String   // docx | xlsx | pptx
  filename   String
  storageKey String
  size       Int
  version    Int      @default(1)
  createdAt  DateTime @default(now())
  session    Session  @relation(fields: [sessionId], references: [id])
  run        Run      @relation(fields: [runId], references: [id])

  @@index([sessionId])
  @@index([tenantId])
}
```

- `Session` / `Run` 需补反向关系字段 `artifacts Artifact[]`。
- 版本计算：落库时查 `where { sessionId, filename }` 的最大 `version`，新行取 `max + 1`；无历史则 `1`。

## 5. 共享契约（packages/shared）

```ts
// RunRequest 增 tenantId
export interface RunRequest {
  runId: string;
  sessionId: string;
  tenantId: string;      // 新增：产物 Key 需按租户隔离
  goal: string;
  messages: ChatMessage[];
}

/** 工具产出物的引用；artifact step 的 payload 即此类型。 */
export interface ArtifactRef {
  kind: 'docx' | 'xlsx' | 'pptx';
  filename: string;
  storageKey: string;
  size: number;
}

/** 成果区列表项。 */
export interface ArtifactDto {
  id: string;
  kind: 'docx' | 'xlsx' | 'pptx';
  filename: string;
  size: number;
  version: number;
  createdAt: string;
}
```

`StepType` 已含 `'artifact'`（M0 起预留），无需改动。

## 6. 运行时工具（apps/agent-runtime/src/tools/doc.ts）

三工具入参为结构化 JSON（引导模型产出合法结构）；统一「生成字节 → 上传 → 返回 `{ artifact: ArtifactRef }`」。

| 工具 | 入参 JSON |
|---|---|
| `doc.docx` | `{ filename, title?, sections: [{ heading?, paragraphs: string[] }] }` |
| `doc.xlsx` | `{ filename, sheets: [{ name, rows: (string \| number)[][] }] }` |
| `doc.pptx` | `{ filename, slides: [{ title?, bullets: string[] }] }` |

- 生成后调用 `putObject(storageKey, bytes, contentType)`；`contentType` 分别为 docx/xlsx/pptx 的 MIME。
- 返回 `{ artifact: { kind, filename, storageKey, size } }`。
- 依赖：`docx`、`exceljs`、`pptxgenjs`（对齐上游 §2）。**生成器纯函数化**（输入 JSON → Buffer），与上传解耦，便于单测。

**每轮运行上下文注入（关键）**：文档工具需要 `tenantId` / `runId` 拼 Key 前缀，但 M1 的工具集在服务启动时一次性构建（`createTools()`）、跨 run 共享，拿不到单次运行的信息。因此扩展工具契约：

```ts
export interface RunContext {
  tenantId: string;
  sessionId: string;
  runId: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}
```

- `agent-loop` 用 `req.tenantId / sessionId / runId` 构造 `ctx`，在每个 `tool.execute(args, ctx)` 里透传。
- 文档工具从 `ctx` 取 `tenantId`/`runId` 拼 Key；`web.search`/`web.fetch` 忽略 `ctx`。
- 存储实例（`storage/s3.ts`）在服务启动时构建一次即可（无运行态），经 `createDocTools(storage)` 注入；故仍是「启动期构建工具集」，只是运行期信息改走 `ctx`。

**agent-loop 变更**：工具执行后，若结果对象含 `artifact` 字段（形如 `ArtifactRef`），在 `tool_result` step 之后再 `yield` 一条 `artifact` step（payload = 该 `ArtifactRef`）。该行为需单测固化。

## 7. 存储封装（apps/agent-runtime/src/storage/s3.ts）

- 用 `@aws-sdk/client-s3` 建 `S3Client`（`endpoint` / `region` / 凭证取自 env，`forcePathStyle: true` 适配 MinIO）。
- 暴露 `putObject(key, body, contentType): Promise<void>` 与 `getObjectStream(key)`（下载代理用）。
- **`ensureBucket()`**：服务启动时幂等检查并创建 bucket（HeadBucket 失败则 CreateBucket），避免依赖额外的初始化容器。
- 配置：`S3_ENDPOINT`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET`（默认 `artifacts`）。BFF 与 runtime 共用同一组 env。
- BFF 侧单独一份只读为主（下载），runtime 侧以写为主；实现同一封装、各自实例化。

## 8. BFF 模块（apps/bff/src/artifacts）

- `ArtifactService`
  - `record(runId, sessionId, tenantId, ref: ArtifactRef): Promise<void>`（算 version、落库）。
  - `list(sessionId, tenantId): Promise<ArtifactDto[]>`（先校验会话归属 → 查产物，按 `createdAt` 倒序）。
  - `getForDownload(id, tenantId): Promise<{ artifact; stream }>`（校验租户 → 返回对象流）。
- `ArtifactController`
  - `GET /api/sessions/:id/artifacts` → `ArtifactDto[]`。
  - `GET /api/artifacts/:id/download` → 设为 `content-type`(按 kind) + `content-disposition: attachment; filename=...`，流式回传。
- `tasks.controller`：在解析 SSE 的 `for (const m of parse(chunk))` 内，`m.event === 'step'` 且 `ev.type === 'artifact'` 时调 `artifacts.record(...)`；落库失败只记日志、不中断流（沿用 `safeFinish` 的容错姿态）。
- `tasks.service.prepare` 需把 `tenantId` 放进回传给 runtime 的 `RunRequest`。

## 9. Web 成果区（apps/web）

- `lib/api.ts` 增 `listArtifacts(sessionId)`、`downloadArtifact(id)`（`fetch` 取 blob → `URL.createObjectURL` → 触发保存；JWT 走请求头，故不能用 `<a href>`）。
- `lib/render-step.ts` 的 `artifact` 分支保留/完善为人类可读文案（如「产出文档 X.pptx」）。
- 工作台 `page.tsx`：选中的 `sessionId` 变化时拉 `listArtifacts`；页面下方渲染成果卡片（`类型 / 文件名 / 大小 / 时间 / 版本` + 下载按钮）；收到 `artifact` step 时即时把新卡片并入列表。

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 模型给的文档 JSON 不合法 | 工具抛错 → `tool_result ok:false` → Loop 继续（M1 既有机制） |
| MinIO 上传失败 | 同上，记为工具失败，不中断整轮 |
| `artifact` step 落库失败 | 记日志、不中断 SSE 流 |
| 下载：产物不存在 / 非本租户 | 404（不泄露存在性） |
| 下载：DB 有行但 MinIO 对象缺失 | 502 |

## 11. 测试策略

- **runtime**
  - `tools/doc.test.ts`：生成器纯函数单测（用 `docx`/`exceljs`/`pptxgenjs` 反解字节，断言标题/段落/表头/数据行）；工具层注入假 storage，断言返回 `ArtifactRef` 与 Key 前缀（含 tenantId/runId）。
  - `agent-loop.test.ts` 增测：工具结果含 `artifact` → 事件序列多一条 `artifact` step。
  - `storage/s3.test.ts`：以假 S3 client 断言 `putObject` 入参与 path-style。
- **bff**
  - `artifacts.service.test.ts`：内存假 Prisma + 假 S3，覆盖 version 递增、租户越权 404。
  - `artifacts.controller.test.ts`：下载路由头正确、越权 404。
  - `tasks.controller.test.ts` 增测：SSE 里出现 `artifact` step → 调用 `record`。
- **e2e（真栈）**：下达「生成一份三页 PPT」→ SSE 出现 `artifact` step → `GET /api/artifacts/:id/download` 取到合法 pptx 字节。**需真实 `DEEPSEEK_API_KEY`**：`MockGateway` 只发 `web.search`，不会触发文档工具，故 mock 模式下无法覆盖本期 e2e。

## 12. 未决 / 已知取舍

- 在线预览与版本回滚 UI 留后续期。
- 下载代理由 BFF 中转字节；量大时可改 MinIO 预签名 URL 直连（需暴露 MinIO 且牺牲内网私有），本期不做。
- MinIO 生命周期/清理策略本期不做（产物只增不减）。
