# M5a「计费与网关」· 订阅套餐 + 积分账本 + 用量结算 + 模型网关收口 · 设计文档

- 日期：2026-10-19
- 状态：待用户审阅
- 关联：`docs/develop/05-dev-plan.md` 第 5 节（M5-1/M5-2/M5-5）、`docs/design/01-overview-design.md` 第 6/8 节
- 前置：M0–M4b 已交付（326 个测试通过，构建 4/4）
- 说明：M5 含计费、可观测、队列、上线等独立子系统，拆为 **M5a 计费与网关**（本文档）、**M5b 可观测 + 队列**、**M5c 支付与上线**。本文档只覆盖 M5a。

## 1. 背景与目标

M1–M4b 已跑通「会话 → Agent Loop → 工具/知识库/MCP → 产物」的完整闭环，但没有任何成本约束：模型调用量、租户配额、用量归属均不可见。M5「个人版可对外」的第一道门槛是**可计费、可控成本**。对标 WorkBuddy 的「订阅套餐 + 月度积分」模型，M5a 交付：

**目标**
- **套餐与月度积分**：租户订阅套餐，每月发放基础积分 + 赠送积分；积分到期作废、不结转。
- **用量可结算**：每次运行按模型输入/输出 token 折算积分，落用量记录与不可变账本。
- **成本可控**：运行前校验余额与速率，运行中按预算硬停，余额不允许扣成负数。
- **网关收口**：模型选择、主备 fallback、运行速率限制集中在网关/BFF，客户端与 runtime 不自行定价。
- **用户可见**：新增「套餐与用量」页，展示当前套餐、余额、流水与按日/模型用量。

**验收（对齐 dev-plan）**
1. 个人用户可注册使用并看到用量；余额不足时无法发起运行（402），充值/开套餐后恢复。
2. 一次真实运行的 token 用量在 `UsageRecord` 与 `CreditLedger` 中可追溯，重复结算不重复扣费。
3. 运行超出预算时自动停止并给出提示，余额不为负。
4. 全量 `pnpm test` 与 `pnpm build` 通过。

**非目标（本期明确不做）**
- **支付网关/自动续费/发票/退款**：管理员通过 API 开通套餐与调整积分；支付与退款评估放 M5c。
- **加油包/优惠券/邀请返利**：积分模型预留 `pack` 来源，但首期无购买入口。
- **企业席位与共享积分池**：M5a 只做租户级账本，企业版属后续。
- **真实模型价格自动同步**：`ModelPrice` 由种子/管理员维护。
- **可观测看板、任务队列、断点续跑**：M5b。
- **管理后台 UI**：管理操作先走 API（`AdminGuard`）。

## 2. 已确认的关键决策

| 议题 | 决策 | 理由 |
|---|---|---|
| 计费主体 | **租户（Tenant）** | 个人租户即单用户；企业租户后续可在同一账本上做席位共享 |
| 计费模型 | **订阅套餐 + 月度积分**，积分到期作废、不结转 | 对标 WorkBuddy；实现简单、成本可预测 |
| 套餐档位 | 体验/标准/高级/旗舰四档，数值进 `Plan` 表（种子可改，不硬编码） | 保留调价空间，不改代码 |
| 积分换算 | 按模型配置「每千 token 的毫积分费率」，运行结束统一向上取整，最低 1 积分 | 整数运算避免浮点误差；费率可独立调整 |
| 扣费顺序 | 最早到期优先；同到期时间基础积分先于赠送积分，再于加油包 | 对标 WorkBuddy；避免赠送积分长期占用 |
| 并发安全 | 运行前**预占（hold）**信用额度，结算时多退少补 | 防止同一余额被并发运行重复消费 |
| 预算执行点 | BFF 下发 `maxCredits` + 价格；runtime 每轮累计，超预算发 `notice` 并停止 | runtime 最接近模型调用，能及时刹车 |
| 网关位置 | runtime 内 `RoutingGateway`：按 BFF 下发的允许模型顺序选择，可重试错误切下一个 | BFF 不接触模型密钥，保持现有边界 |
| 限流位置 | BFF 按租户每分钟运行数（Redis 令牌桶；无 Redis 时进程内实现） | 控制成本入口；不增加 runtime 的外部依赖 |
| 用量落库 | BFF 收到 `usage` 事件立即写 `UsageRecord(pending)`，结束时结算；定时补偿 | 客户端断开也能结算，失败可重试 |
| 客户端断开 | 停止向客户端写，但**继续排空上游**直到 `done`/超时（不再立即 cancel reader） | 保证 usage 与产物落库、run 正常收尾；否则断开即漏计 |
| 契约缺省 | `RunRequest.billing` 缺省时不限预算（仅测试/兼容），生产 BFF 必传 | 避免旧测试与本地脚本失效 |
| 失败处理 | 无 usage 事件记 0；结算失败保留 pending 由补偿任务重试；不自动退款 | 简单、可审计；人工调整入口保留 |
| 禁用行为 | 旧租户懒迁移到 free 套餐，注册时也可预创建 | 不阻塞存量数据与测试 |

## 3. 架构与数据流

### 3.1 分层变更

- **shared**：
  - `RunRequest` 增可选 `billing: { maxCredits, allowedModels, prices }`；`prices` 为 `Record<model, { inputMilliCreditsPer1k, outputMilliCreditsPer1k }>`。
  - 新增 `UsageEvent`：`{ input, output, models: { model, input, output }[] }`（`usage` SSE 事件的 data）。
  - `StepType` 增 `'notice'`；`NoticePayload = { code: 'budget_exceeded', message: string }`。
  - 新增计费 DTO：`PlanDto`、`BillingSummaryDto`、`CreditLedgerItemDto`、`UsageQueryDto`、`UsageAggregateDto`。
- **bff**：
  - Prisma 新增 `Plan` / `Subscription` / `CreditLot` / `CreditTx` / `TenantCredit` / `CreditHold` / `UsageRecord` / `ModelPrice`（§4）。
  - 新增 `billing/`：`billing.service.ts`（套餐、授信、预占、结算、过期、查询）、`billing.controller.ts`（用户查询 + 管理员开通/调整）、`billing.rate-limit.ts`（Redis/内存令牌桶）、`billing.sweeper.ts`（补偿与过期扫描）、`billing.module.ts`。
  - `tasks.controller.ts`：开跑前做限流 + 预占；解析 `usage` 事件写 pending 用量；`finally` 中结算/释放预占。
  - `tasks.service.ts`：`prepare` 接受外部生成的 `runId`，并拆出归属校验，便于在创建前完成计费检查。
  - `auth`：注册后 best-effort 调用 `billing.ensureSubscription(tenantId)`；所有计费入口再做懒创建兜底。
  - `docker-compose.yml` 增 Redis；`.env.example` 增 `REDIS_URL`、`MODEL_PROVIDERS`。
- **agent-runtime**：
  - `model/types.ts`：`ChatRequest` 增 `models?: string[]`；`ChatResponse` 增 `model: string`。
  - 新增 `model/routing-gateway.ts`：按允许模型顺序路由，可重试错误 fallback；`create-gateway.ts` 从 `MODEL_PROVIDERS` 构建，缺省回退现有单模型配置。
  - `agent-loop.ts`：累计 `models → tokens`；每轮后按价格算积分，超预算时发 `notice` 并停止；结束时 `onUsage` 发新 `UsageEvent`。
  - `server.ts`：把 `runReq.billing` 传入 loop；`usage` 事件结构升级。
- **web**：
  - 新增 `/billing` 页（套餐与用量）：套餐卡片、余额/到期、流水、按日/模型用量。
  - `lib/api.ts` 增 `getBillingSummary` / `listCreditLedger` / `getUsage` / `listPlans`。
  - 工作台渲染 `notice` 步骤（预算超限提示）。

**边界不变式**：BFF 独占 Postgres 与计费决策；runtime 只执行预算与路由，不读写账本；模型密钥仅存在于 runtime 环境。

### 3.2 开跑与结算流

```
Web                BFF                                         Runtime
 | POST /api/sessions/:id/tasks ─▶
 |                  归属校验
 |                  限流（Redis 令牌桶，超限 429）
 |                  预占：锁 TenantCredit → reserved += maxCredits
 |                        → 建 CreditHold(runId)
 |                  建 Task/Run（runId 由 BFF 预生成）+ 用户消息
 |                  下发 RunRequest{billing:{maxCredits,allowedModels,prices}} ─▶
 |                                                                   RoutingGateway 选模型
 |                                                                   loop 每轮累计用量/成本
 |                                                                   ≤maxCredits → 继续
 |                                                                   >maxCredits → notice 并停止
 |                  ◀─ SSE: step / usage / done ────────────────────
 |                  收到 usage（累计值，保留最后一次）→ UsageRecord(pending)
 |                  客户端断开：停止转发但仍排空上游，直到 done/超时
 |                  finally：结算 pending → 扣 lot/balance、释放 hold
 |  ◀─ SSE 转发完成 ─
```

- **预占**：`maxCredits = min(plan.maxCreditsPerRun, balance - reserved)`；不足 1 积分直接 402，不建任何记录。
- **结算**：实际积分 `credits = max(1, ceil(Σ 模型毫积分成本 / 1000))`，并 `min(credits, hold.amount)`；多退少补。
- **幂等**：`UsageRecord.runId`、`CreditTx.runId` 均唯一；重复结算直接返回。
- **异常**：上游不可达/HTTP 非 2xx/无 usage → 释放 hold、不扣费；结算抛错 → hold 保留，`UsageRecord` 保持 pending，补偿任务重试。

### 3.3 积分生命周期

```
订阅周期开始 ── 发放 base lot + bonus lot（expiresAt = periodEnd）
运行结算 ── 按 expiresAt 升序、base→bonus→pack 扣减 lot
周期结束 ── 剩余 lot 过期：写 expire 流水、remaining=0、balance 减少
免费套餐 ── 周期结束自动续期并重新发放；付费套餐过期后需管理员续开
```

## 4. 数据模型

```
Plan
  id String @id                  // free | standard | premium | ultimate
  name String
  priceCents Int                 // 展示价（分）；不参与扣费
  monthlyBaseCredits Int
  monthlyBonusCredits Int
  maxCreditsPerRun Int
  rpm Int                        // 每分钟最大运行发起数
  allowedModels String[]
  active Boolean @default(true)
  createdAt DateTime

Subscription
  id String @id
  tenantId String @unique
  planId String
  status String                  // active | expired | canceled
  periodStart DateTime
  periodEnd DateTime
  createdAt / updatedAt

CreditLot
  id String @id
  tenantId String
  source String                  // base | bonus | pack | adjust
  granted Int
  remaining Int
  expiresAt DateTime?
  note String?
  createdAt DateTime
  @@index([tenantId, expiresAt])

CreditTx                         // 只追加，不更新、不删除
  id String @id
  tenantId String
  type String                    // grant | consume | expire | adjust | refund
  amount Int                     // 有符号：发放/调整为 +，消耗/过期为 -
  source String?
  runId String? @unique
  note String?
  createdAt DateTime
  @@index([tenantId, createdAt])

TenantCredit
  tenantId String @id
  balance Int                    // 未过期、未消耗的积分总额（含已预占）
  reserved Int @default(0)       // 进行中运行动预占的积分
  updatedAt DateTime

CreditHold
  runId String @id
  tenantId String
  amount Int
  createdAt DateTime
  expiresAt DateTime             // 兜底清理用（24h）
  @@index([tenantId])

UsageRecord
  id String @id
  runId String @unique
  tenantId String
  userId String
  sessionId String
  models Json                    // [{model,input,output}]
  inputTokens Int
  outputTokens Int
  credits Int?
  status String                  // pending | settled | void
  createdAt / settledAt
  @@index([tenantId, createdAt])

ModelPrice
  model String @id
  inputMilliCreditsPer1k Int
  outputMilliCreditsPer1k Int
  updatedAt DateTime
```

**种子值**（可经 SQL/管理接口调整，不写进业务代码）：

| 套餐 | 价格 | 基础/赠送积分 | 单次上限 | RPM | 允许模型 |
|---|---|---|---|---|---|
| free 体验版 | 0 元 | 500 / 0 | 50 | 10 | deepseek-chat |
| standard 标准版 | 99 元 | 2000 / 2000 | 200 | 30 | deepseek-chat, deepseek-reasoner |
| premium 高级版 | 199 元 | 4000 / 5000 | 500 | 60 | 同上 |
| ultimate 旗舰版 | 999 元 | 20000 / 30000 | 2000 | 120 | 同上 |

| 模型 | 输入（毫积分/1K token） | 输出（毫积分/1K token） |
|---|---|---|
| deepseek-chat | 100 | 300 |
| deepseek-reasoner | 200 | 800 |
| mock | 100 | 300 |

> 毫积分 = 1/1000 积分。上述费率下，一次 4000 token 的普通对话约 1 积分，与 WorkBuddy 的量级对齐。`mock` 用于本地/CI 路由，保证链路可测。

## 5. 接口契约

### 5.1 用户接口（JWT）

| 方法 | 路径 | 出参 |
|---|---|---|
| GET | `/api/billing/plans` | `200 PlanDto[]`（套餐目录） |
| GET | `/api/billing/summary` | `200 BillingSummaryDto` |
| GET | `/api/billing/ledger?limit=50&cursor=` | `200 { items: CreditLedgerItemDto[], nextCursor: string \| null }` |
| GET | `/api/billing/usage?from=&to=&groupBy=day\|model` | `200 UsageAggregateDto[]` |

`BillingSummaryDto`：
```ts
{
  plan: PlanDto;
  subscription: { status: string; periodStart: string; periodEnd: string };
  balance: number;          // 可用 = balance - reserved
  reserved: number;
  nextExpiry: { amount: number; expiresAt: string } | null;
}
```

`CreditLedgerItemDto`：`{ id, type, amount, source, runId, note, createdAt }`。

`UsageAggregateDto`：`{ key, credits, inputTokens, outputTokens, runs }`（`key` 为日期或模型名）。

### 5.2 管理员接口（JWT + AdminGuard，操作调用者所在租户）

| 方法 | 路径 | 入参 | 说明 |
|---|---|---|---|
| POST | `/api/billing/admin/subscribe` | `{ planId }` | 开通/续期：写 Subscription、发放本期 lot；`free` 不允许手动开 |
| POST | `/api/billing/admin/credits` | `{ amount, note, expiresAt? }` | 正数发放（`source=adjust`）、负数收回；不得使余额为负 |

> 跨租户超级管理员、支付回调、退款审批属 M5c。

### 5.3 runtime 契约变更（内部）

`RunRequest` 追加：
```ts
billing?: {
  maxCredits: number;
  allowedModels: string[];
  prices: Record<string, { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number }>;
};
```

`usage` SSE 事件 data：
```ts
{ input: number; output: number; models: [{ model: string; input: number; output: number }] }
```

`notice` step payload：
```ts
{ code: 'budget_exceeded'; message: '本次运行已达到积分预算上限，已停止' }
```

## 6. 关键实现细节

### 6.1 计费服务（BFF）

- `ensureSubscription(tenantId)`：无订阅 → 创建 free 订阅并发放；free 过期 → 推进到下一周期并重新发放；付费过期 → `status='expired'`。所有入口（summary / 预占 / 注册）先调用，保证懒迁移。
- `reserve(runId, tenantId)`：事务内 `SELECT ... FOR UPDATE` 锁 `TenantCredit`；先执行 `expireDueLots`；计算可用额度；写 `CreditHold` 并增加 `reserved`；返回 `maxCredits`。
- `recordUsage(runId, …)`：`UsageRecord` upsert（runId 唯一），status=pending。
- `settle(runId)`：事务内锁 `TenantCredit`；读 pending 记录；按 `ModelPrice` 计算积分；按到期顺序扣减 lot；写一条 `consume` 流水（runId 唯一）；减少 `balance` 与 `reserved`，删除 hold；标记 settled。余额不足时按可用额度封顶并记录告警日志。
- `releaseHold(runId)`：无 pending 用量或运行失败时，仅减少 `reserved` 并删除 hold。
- `expireDueLots(tenantId, now)`：对 `expiresAt <= now` 且 `remaining > 0` 的 lot 写 `expire` 流水并清零。
- `sweeper`：每分钟结算超过 1 分钟的 pending 记录；每天扫描过期 lot 与超过 24h 的孤儿 hold（仅当对应 run 已非 running）。

### 6.2 扣减顺序

```sql
ORDER BY "expiresAt" ASC NULLS LAST,
         CASE source WHEN 'base' THEN 0 WHEN 'bonus' THEN 1
                     WHEN 'pack' THEN 2 ELSE 3 END
```

### 6.3 限流

- Redis 固定窗口：`INCR rl:{tenantId}:{floor(now/60s)}`，首次设置 120s 过期；计数 > `plan.rpm` → `429 { error: 'rate_limited', retryAfter }`。
- 未配置 `REDIS_URL` 时使用进程内 Map（单实例可用，多实例需 Redis）。
- Redis 故障时**放行并告警**：限流是可用性辅助，预算与账本仍是硬约束。

### 6.4 模型路由与 fallback（runtime）

- `MODEL_PROVIDERS`（JSON 数组）：
  ```json
  [
    { "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    { "model": "deepseek-reasoner", "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  ]
  ```
  未配置时回退 `MODEL_BASE_URL` + `MODEL_NAME` + `DEEPSEEK_API_KEY` 单模型。
- 每次 `chat`：取 `req.models` 与已注册模型的交集，按顺序尝试；仅对网络错误、429、5xx 切下一个，4xx（参数/鉴权）直接失败，避免放大错误。
- 未配置任何 provider 时 runtime 处于 mock 模式（无 API key 的本地/CI 显式配置）：交集为空则回退 `mock` 并上报 `model='mock'`；已配置 provider 但交集为空则报错，不静默绕过套餐限制。
- `ChatResponse.model` 回传实际模型，供用量归集。

### 6.5 预算执行（runtime）

- 每轮结束累计 `usageByModel` 与毫积分成本。
- 成本超过 `maxCredits` 时不再发起下一轮，发 `notice`，跳出循环；`onUsage` 仍上报已产生用量。
- `usage` 事件为截至当前的**累计值**；BFF 只保留最后一次，避免重复累计。
- 最终积分由 BFF 统一计算并封顶在 hold 金额，runtime 只做预算判断，不落账。

### 6.6 现有代码改动点

- `apps/agent-runtime/src/agent-loop.ts`：`RunDeps` 增 `billing?: RunBilling`；累计改为按模型；预算判断；`notice` 事件。
- `apps/agent-runtime/src/server.ts`：把 `runReq.billing` 透传。
- `apps/agent-runtime/src/model/openai-compat.ts`：错误携带 HTTP 状态（供 fallback 判定）；返回 `model`。
- `apps/bff/src/tasks/tasks.controller.ts`：限流 → 预占 → 建 run → 转发；收集 `usage`；finally 结算/释放。客户端断开后改为**排空上游**（停止写回复、继续读取），保证 usage/产物落库；不再立即 `reader.cancel()`。
- `apps/bff/src/tasks/tasks.service.ts`：`prepare` 接受预生成 `runId`；拆出 `assertOwned`。
- `apps/bff/src/auth/auth.service.ts`：注册后 best-effort `ensureSubscription`。
- `apps/bff/scripts/apply-comments.mjs`：为新表/列补中文 SQL 注释（项目约定）。
- `apps/bff/docker-compose.yml`：增 `redis:7.4-alpine`（固定小版本）；`.env.example` 增 `REDIS_URL`、`MODEL_PROVIDERS`。

## 7. 安全与一致性

- 客户端不能传价格、预算或积分；`maxCredits`、`allowedModels`、`prices` 均由 BFF 依据账本生成。
- `CreditTx` 只追加；所有更正走 `adjust` 流水，保留审计链。
- 预占与结算均锁 `TenantCredit` 行，保证 `reserved ≤ balance`、余额非负。
- 跨租户查询一律按 JWT `tenantId` 过滤；管理接口校验 `AdminGuard`。
- 时间统一用 UTC；套餐周期按自然月推进，避免时区漂移。
- 用量记录含 `userId`/`sessionId`/`runId`，但不存 prompt 内容，降低隐私面。

## 8. 测试策略

- **runtime 单测**：按模型累计用量；预算超限发 `notice` 并停止；fallback 仅在可重试错误触发；`usage` 事件结构。
- **bff 单测**：积分换算与取整；lot 扣减顺序（到期时间 → base/bonus）；预占/释放/多退少补；`runId` 幂等；402/429 分支；无 usage 不扣费。
- **bff 集成**：假 gateway 产出 usage → UsageRecord + CreditTx + 余额一致；客户端断开后仍完成结算。
- **web**：`/billing` 渲染摘要/流水/空态；`notice` 步骤渲染。
- **回归**：现有 326 个测试需注入计费桩或 free 套餐；`pnpm build` 4/4。

## 9. 风险与待观察

| 风险 | 处置 |
|---|---|
| 积分费率定价不合理 | 全部在 `Plan`/`ModelPrice` 表，可 SQL 调整；先用上表种子观察 |
| 运行中途模型返回超长导致超预算 | 预占封顶 + 结算 `min(hold)`，超出部分由平台吸收并记日志 |
| Redis 不可用 | 限流降级为进程内/放行；账本不依赖 Redis |
| 结算失败导致漏计 | pending 用量 + 每分钟补偿；失败告警 |
| 并发运行预占竞争 | 行锁 + 唯一 hold；24h 孤儿清理 |
| 旧租户无订阅 | 懒创建 free 订阅；首次访问即补发 |

## 10. 交付顺序（供实施计划参考）

1. 数据模型与种子（Plan/ModelPrice/账本/用量）。
2. shared 契约（billing DTO、UsageEvent、notice）。
3. BFF 计费核心（ensure/reserve/settle/expire/补偿）+ 单测。
4. runtime 用量结构 + 预算 + 路由 fallback + 单测。
5. BFF `tasks` 接入（限流、预占、usage、结算）+ 集成测试。
6. 查询接口与 Web `/billing` 页。
7. 回归、构建、端到端验收。
