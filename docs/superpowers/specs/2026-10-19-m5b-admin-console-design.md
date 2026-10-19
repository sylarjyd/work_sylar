# M5b-1 管理端设计（Admin Console）

- 日期：2026-10-19
- 状态：待评审
- 里程碑：M5b-1（M5b-2 可观测、M5b-3 队列在后续排期）
- 关联：`docs/superpowers/specs/2026-10-15-ai-office-agent-design.md`、`docs/develop/05-dev-plan.md`

## 1. 目标与范围

为平台运营提供跨租户管理后台，覆盖六块能力：

1. 用户管理
2. 会员管理（租户订阅、积分、套餐目录）
3. 会话管理
4. 会话消息与任务管理
5. 模型配置（价格与套餐白名单）
6. 参数配置（运行/KB 白名单参数）

写入遵循**非破坏性**原则：状态切换、配置修改，不提供硬删除。所有写操作与敏感查看落审计日志。

## 2. 非目标

- 租户级管理员（`tenant_admin`）与细粒度 RBAC。
- 硬删除用户/租户/会话/任务/消息。
- 在线配置 provider 密钥或 Base URL（继续由环境变量维护）。
- 密码重置、邮件通知。
- 任务取消/重试（依赖 M5b-3 队列）。
- 跨租户数据导出。
- OTel、指标端点、看板（M5b-2）。

## 3. 架构

### 3.1 权限模型

- 平台管理员单一角色：`User.role === 'admin'`，跨租户读写全部管理实体。
- 普通注册用户一律 `member`；管理员仍由 `pnpm --filter @ai-office/bff admin:promote <email>` 预置。
- 所有管理接口位于 `/api/admin/*`，统一 `@UseGuards(JwtGuard, AdminGuard)`。

### 3.2 鉴权重构

现状 `JwtGuard` 只验签、不查库，`AdminGuard` 再查一次角色。改为：

- `JwtGuard`：验签后按 `sub` 查询 `User`，要求用户存在且 `status === 'active'`，否则 401；把 `{ sub, tenantId, role }` 挂到 `req.user`。
- `AdminGuard`：只判断 `req.user.role === 'admin'`，不再查库。
- 效果：禁用用户立即失效（含已签发 token）；角色变更即时生效。
- 登录：`User.status !== 'active'` 返回 401 `invalid_credentials`，与密码错误一致，避免账号枚举。
- 代价：每个受保护请求多一次主键查询，当前规模可接受。

### 3.3 Web 后台

- 新增独立 `/admin` 后台，自带侧栏与「返回工作台」，不复用工作台导航。
- 路由：`/admin/users`、`/admin/tenants`、`/admin/plans`、`/admin/sessions`、`/admin/tasks`、`/admin/models`、`/admin/settings`、`/admin/audit`；`/admin` 重定向到 `/admin/users`。
- 入口：`AppShell` 在 `ai_office_role === 'admin'` 时显示「管理后台」；服务端 403 为准。
- 页面挂载时若角色非 admin，直接跳回 `/`；接口 403 同样跳回并提示无权限。
- 列表统一 offset 分页：`page`（≥1）、`pageSize`（1–100，默认 20），返回 `{ items, total, page, pageSize }`，按 `createdAt desc` 排序；搜索使用大小写不敏感匹配。
- 所有写操作使用二次确认（对话框列出变更前后值）；错误统一走现有 `errorText`。

## 4. 数据模型

新增两张表（Prisma）：

```prisma
model Setting {
  key       String   @id
  value     Json
  updatedBy String?
  updatedAt DateTime @updatedAt
}

model AdminAuditLog {
  id         String   @id @default(uuid())
  actorId    String
  actorEmail String
  action     String
  targetType String
  targetId   String?
  summary    Json?
  ip         String?
  createdAt  DateTime @default(now())

  @@index([createdAt])
  @@index([targetType, targetId])
  @@index([actorId, createdAt])
}
```

沿用现有字段：

- 用户：`User.status`（`active|disabled`）、`User.role`（`member|admin`）。
- 会话：`Session.status`（`active|archived`）。
- 任务/运行：`Task.status`、`Run.status/startedAt/endedAt`。
- 套餐：`Plan`；模型价格：`ModelPrice`。

不新增 `Tenant` 与 `User` 的关系字段，列表通过现有 `tenant` 关联查询。

## 5. 接口与功能

所有接口返回 DTO 定义在 `packages/shared`。管理端接口不返回任何密钥。

### 5.1 用户管理

- `GET /api/admin/users?q=&status=&role=&page=&pageSize=`
  - 返回：id、email、tenantId、tenantName、role、status、createdAt。
  - `q` 匹配邮箱（大小写不敏感）。
- `GET /api/admin/users/:id`
  - 返回：用户详情 + 租户名 + 订阅套餐/状态 + 余额/预占 + 会话数。
  - 审计：`user.view`。
- `PATCH /api/admin/users/:id` body `{ status?, role? }`
  - `status ∈ {active, disabled}`，`role ∈ {member, admin}`。
  - 不变量：不能修改自己；不能禁用或降级自己；不能移除最后一个 `active` 管理员。
  - 审计：`user.update`，summary 记录变更前后值。

### 5.2 会员管理

- `GET /api/admin/tenants?q=&planId=&page=&pageSize=`
  - 返回：tenantId、name、type、planId/planName、订阅状态、余额、预占、用户数、createdAt。
- `GET /api/admin/tenants/:id`
  - 返回：租户详情 + 计费摘要（复用 `BillingService.summary`）+ 用户数 + 会话数。
  - 审计：`tenant.view`。
- `POST /api/admin/tenants/:id/subscribe` body `{ planId }`
  - 复用 `BillingService.adminSubscribe`，目标租户取路径参数而非调用者租户。
  - 审计：`member.subscribe`。
- `POST /api/admin/tenants/:id/credits` body `{ amount, note?, expiresAt? }`
  - 复用 `BillingService.adjust`；金额与上限校验沿用现有规则。
  - 审计：`member.credits`，summary 记录金额、备注、到期时间。

### 5.3 套餐目录

- `GET /api/admin/plans`：全部套餐（含停用）。
- `POST /api/admin/plans`：创建；`id` 为 slug（`^[a-z][a-z0-9-]{1,30}$`），不可重复。
- `PATCH /api/admin/plans/:id`：更新名称、价格、月度额度、单次上限、RPM、`allowedModels`、`active`。
- 校验：
  - 数值非负；`monthlyBaseCredits`/`monthlyBonusCredits`/`maxCreditsPerRun`/`rpm` 为整数。
  - `allowedModels` 非空、去重，且每个模型都必须存在 `ModelPrice` 记录。
  - `free` 套餐不可停用、不可修改 `id`；其余套餐用 `active=false` 代替删除。
- 审计：`plan.create`、`plan.update`。

### 5.4 会话管理

- `GET /api/admin/sessions?tenantId=&userId=&q=&status=&page=&pageSize=`
  - 返回：id、title、status、tenantId、userEmail、消息数、任务数、createdAt。
  - `q` 匹配标题。
- `GET /api/admin/sessions/:id`
  - 返回：会话详情 + 消息数/任务数/产物数；审计 `session.view`。
- `GET /api/admin/sessions/:id/messages?page=&pageSize=`
  - 按 `seq asc` 分页；审计 `messages.view`（只记会话 ID 与分页范围，不记正文）。
- `PATCH /api/admin/sessions/:id` body `{ status: 'archived' }`
  - 归档后：普通用户 `sessions.list` 不再返回该会话；`assertOwned` 视为不存在（404），不可继续对话。
  - 不提供恢复归档（避免误操作回滚歧义）；如需恢复由运维处理。
  - 审计：`session.archive`。

### 5.5 任务与运行

- `GET /api/admin/tasks?tenantId=&sessionId=&userId=&status=&page=&pageSize=`
  - 返回：id、sessionId、goal 摘要（截断 200 字）、status、createdAt、最近一次运行状态。
- `GET /api/admin/tasks/:id`：任务详情 + 运行列表（id、status、startedAt、endedAt、积分）。
  - 审计：`task.view`。
- `GET /api/admin/runs/:id?stepPage=&stepPageSize=`
  - 返回：运行详情 + 分页 step（seq、type、payload、ts）+ `UsageRecord`（tokens/credits/status）。
  - step payload 原样返回（管理员需要排障）；审计 `run.view`。
- 本期只读；取消/重试留给队列期。

### 5.6 模型配置

- `GET /api/admin/models`
  - 返回：当前环境解析出的 provider 清单（仅 provider 名与模型名，**不含密钥**）+ 全部 `ModelPrice`。
- `GET /api/admin/model-prices`
- `POST /api/admin/model-prices` body `{ model, inputMilliCreditsPer1k, outputMilliCreditsPer1k }`
- `PATCH /api/admin/model-prices/:model` body `{ inputMilliCreditsPer1k?, outputMilliCreditsPer1k? }`
- `DELETE /api/admin/model-prices/:model`
  - 仅当没有任何启用套餐的 `allowedModels` 引用该模型时允许；否则 400 `model_in_use`。
  - 删除后若该模型仍出现在停用套餐中，仅影响停用套餐，不阻断。
- 校验：模型名非空；milli-credits 为非负整数。
- 审计：`modelPrice.create`、`modelPrice.update`、`modelPrice.delete`。

### 5.7 参数配置

白名单与范围：

| key | 类型 | 范围 | 默认来源 |
|---|---|---|---|
| `maxRounds` | int | 1–32 | runtime `DEFAULT_MAX_ROUNDS`（8） |
| `confirmTimeoutMs` | int | 1000–600000 | `CONFIRM_TIMEOUT_MS`（120000） |
| `codeExecTimeoutMs` | int | 100–60000 | `CODE_EXEC_TIMEOUT_MS`（5000） |
| `kbChunkSize` | int | 100–4000 | `KB_CHUNK_SIZE`（800） |
| `kbChunkOverlap` | int | 0–1000 且 `< kbChunkSize` | `KB_CHUNK_OVERLAP`（150） |

- `GET /api/admin/settings`
  - 返回每个 key 的生效值、来源（`db|env|default`）、更新时间与更新人。
- `PUT /api/admin/settings/:key` body `{ value }`
  - 类型/范围校验；`kbChunkOverlap` 需与生效的 `kbChunkSize` 联合校验。
  - 审计：`setting.update`。
- `DELETE /api/admin/settings/:key`
  - 删除 DB 覆盖，恢复环境变量/默认值；审计 `setting.reset`。
- 读取：每次 run / 每次 KB 摄取时从 DB 读取（单条索引查询），不做缓存，保证即时生效。

### 5.8 审计

- `GET /api/admin/audit?actorId=&action=&targetType=&targetId=&from=&to=&page=&pageSize=`
- 记录规则：
  - 写操作：与业务写入同事务落库。计费类操作通过给 `BillingService.adminSubscribe/adjust` 增加可选审计上下文，在既有事务内写入。
  - 敏感查看：读取成功后尽力写入；审计写失败只记日志，不阻断读取。
  - 不记录消息正文、密钥、工具入参全文；summary 只放变更前后值或分页范围。
- `ip` 取请求来源地址（考虑反代时取 `x-forwarded-for` 首项，仅在配置了可信反代时；首期直接取 `req.ip`）。

## 6. 参数生效链路

### 6.1 运行参数

- `packages/shared` 的 `RunRequest` 增加可选 `config?: { maxRounds?, confirmTimeoutMs?, codeExecTimeoutMs? }`。
- BFF `SettingsService.getRunConfig()` 读取生效值，随 `/runs` 请求下发。
- runtime 侧：
  - `server.ts` 将 `runReq.config` 传入 `runAgent` 的 deps；缺省回落到环境变量/常量。
  - `maxRounds`、`confirmTimeoutMs` 直接覆盖现有默认。
  - `codeExecTimeoutMs` 通过 `RunContext` 传入 `code.exec`，工具以请求值为上限，并继续受服务端硬上限（60000ms）约束。
  - runtime 对所有下传值做二次类型/范围夹取，不信任 BFF 输入（防御性）。
- `RunRequest` 变更保持向后兼容（字段可选），旧调用方不受影响。

### 6.2 KB 参数

- BFF 调用 runtime `POST /kb/ingest` 时新增 `chunkSize`、`chunkOverlap`。
- runtime 校验为正整数并夹取到同一范围，`overlap < chunkSize`；非法值回落默认。
- 现有环境变量读取保留为兜底。

## 7. 安全与不变量

- 管理接口不返回 `passwordHash`、连接器 `envEncrypted`、任何 API Key。
- 自我保护：
  - 管理员不能禁用/降级自己。
  - 系统始终保留至少一个 `active` 管理员（禁用与降级都检查）。
- 目标存在性校验失败统一 404；权限不足统一 403 `not_admin`；未认证 401。
- 归档会话对普通用户不可见、不可访问；管理员仍可查看。
- 套餐与模型价格变更做引用保护，避免 `beginRun` 出现 `model_price_missing`。
- 审计写入失败不回滚已完成的敏感查看；写操作审计失败则整体失败（同事务）。

## 8. 测试

### 8.1 BFF 单测/集成

- `JwtGuard`：禁用用户 401、不存在用户 401、角色挂载；`AdminGuard` 非管理员 403。
- 用户：分页/搜索、启用禁用、改角色、自我保护、最后管理员不变量。
- 会员：指定租户开通/调额、金额校验。
- 套餐：slug/数值/`allowedModels` 校验、`free` 保护、停用。
- 会话：跨租户列表、归档后普通用户列表与访问行为。
- 任务/运行：分页 step、用量关联。
- 模型：价格 CRUD、引用保护、无密钥泄露。
- 参数：白名单校验、联合校验、生效值来源、DB 覆盖与恢复。
- 审计：写操作与敏感查看记录、失败语义。
- 鉴权重构后的既有 controller 测试需同步更新。

### 8.2 runtime

- `RunRequest.config` 覆盖 `maxRounds`/`confirmTimeoutMs`/`codeExecTimeoutMs`；越界夹取。
- `/kb/ingest` 使用请求中的 chunk 参数；非法值回落。

### 8.3 Web

- admin API 客户端的分页/过滤参数与错误映射。
- 角色入口与 403 跳转逻辑（纯函数/组件级）。

### 8.4 手工验收

1. 管理员登录可见「管理后台」，普通用户不可见且直连 `/api/admin/users` 返回 403。
2. 禁用某用户后，该用户既有 token 立即 401；管理员不能禁用自己。
3. 为租户开通套餐、调整积分，余额与流水正确。
4. 创建/停用套餐、修改模型价格；引用中的价格删除被拒。
5. 查看跨租户会话与任务 step；归档后普通用户列表不可见。
6. 修改 `maxRounds` 后下一次运行按新值停止；修改 KB chunk 参数后摄取生效。
7. 审计页能查到上述写操作与敏感查看记录。
8. `pnpm test`、`pnpm build` 全绿。

## 9. 交付文档

- `docs/deploy/06-deployment.md`：管理员创建、管理端入口与权限、审计表、参数白名单与生效方式。
- `docs/develop/04-dev-guide.md`：本地验证管理端的步骤。
- `docs/develop/05-dev-plan.md`：M5 拆分更新为 M5b-1 管理端（本期交付）、M5b-2 可观测、M5b-3 队列。
