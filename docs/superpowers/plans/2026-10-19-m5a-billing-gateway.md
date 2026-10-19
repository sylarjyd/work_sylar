# M5a「计费与网关」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付订阅套餐 + 月度积分账本 + 用量结算 + 模型网关收口，让个人用户可注册使用、看到用量、余额不足时被拦截，且并发与断连场景不漏计。

**Architecture:** BFF 独占 Postgres 与计费决策（预占 hold → 收 `usage` → 结算）；runtime 只执行预算判断与模型路由（多 provider、可重试 fallback），不读写账本；Web 新增 `/billing` 页展示套餐/余额/流水/用量。账本只追加，`CreditTx.runId` 与 `UsageRecord.runId` 唯一保证结算幂等。

**Tech Stack:** pnpm + turbo、TypeScript、Prisma 6 / PostgreSQL、NestJS 10 + Fastify、Next.js 15、vitest、ioredis、OpenAI 兼容模型协议。

**Spec:** `docs/superpowers/specs/2026-10-19-m5a-billing-gateway-design.md`（已确认）

---

## 执行约定（每个 Task 都适用）

- 仓库根目录：`D:\ws\ai\agent\work_sylar`；shell 为 bash（用 `/` 路径）。
- **直接在 master 开发**，不建特性分支/worktree；每个 Task 结束提交一次，中文提交信息。
- 不提交未跟踪的 `任务.txt`。提交时只 `git add` 本 Task 涉及的文件。
- 常用命令（在仓库根执行）：
  - 单包测试：`pnpm --filter @ai-office/bff test` / `@ai-office/agent-runtime` / `@ai-office/web` / `@ai-office/shared`
  - 单文件测试：`pnpm --filter @ai-office/agent-runtime exec vitest run src/agent-loop.test.ts`
  - 类型检查：`pnpm --filter @ai-office/bff typecheck`（runtime/web/shared 用各自 package 脚本，若没有则 `exec tsc --noEmit`）
  - 构建：`pnpm build`
- BFF 数据库命令：`pnpm --filter @ai-office/bff db:up`、`db:push`（含注释）、`db:generate`、`db:seed:billing`。
- 注释用中文；commit message 用中文，格式 `type(scope): 摘要`。

---

## Task 1: 数据模型、种子与本地基础设施

**Files:**
- Modify: `apps/bff/prisma/schema.prisma`
- Create: `apps/bff/scripts/seed-billing.mjs`
- Modify: `apps/bff/package.json`
- Modify: `apps/bff/prisma/comments.sql`
- Modify: `apps/bff/docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: 在 `schema.prisma` 末尾追加 8 个模型**

```prisma
model Plan {
  id                  String         @id
  name                String
  priceCents          Int
  monthlyBaseCredits  Int
  monthlyBonusCredits Int
  maxCreditsPerRun    Int
  rpm                 Int
  allowedModels       String[]
  active              Boolean        @default(true)
  createdAt           DateTime       @default(now())
  subscriptions       Subscription[]
}

model Subscription {
  id          String   @id @default(uuid())
  tenantId    String   @unique
  planId      String
  status      String   @default("active")
  periodStart DateTime
  periodEnd   DateTime
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  plan        Plan     @relation(fields: [planId], references: [id])

  @@index([planId])
}

model CreditLot {
  id        String    @id @default(uuid())
  tenantId  String
  source    String
  granted   Int
  remaining Int
  expiresAt DateTime?
  note      String?
  createdAt DateTime  @default(now())

  @@index([tenantId, expiresAt])
}

model CreditTx {
  id        String   @id @default(uuid())
  tenantId  String
  type      String
  amount    Int
  source    String?
  runId     String?  @unique
  note      String?
  createdAt DateTime @default(now())

  @@index([tenantId, createdAt])
}

model TenantCredit {
  tenantId  String   @id
  balance   Int      @default(0)
  reserved  Int      @default(0)
  updatedAt DateTime @updatedAt
}

model CreditHold {
  runId     String   @id
  tenantId  String
  amount    Int
  createdAt DateTime @default(now())
  expiresAt DateTime

  @@index([tenantId])
  @@index([expiresAt])
}

model UsageRecord {
  id           String    @id @default(uuid())
  runId        String    @unique
  tenantId     String
  userId       String
  sessionId    String
  models       Json
  inputTokens  Int
  outputTokens Int
  credits      Int?
  status       String    @default("pending")
  createdAt    DateTime  @default(now())
  settledAt    DateTime?

  @@index([tenantId, createdAt])
  @@index([status, createdAt])
}

model ModelPrice {
  model                   String   @id
  inputMilliCreditsPer1k  Int
  outputMilliCreditsPer1k Int
  updatedAt               DateTime @updatedAt
}
```

- [ ] **Step 2: 新建种子脚本 `apps/bff/scripts/seed-billing.mjs`**

```js
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

// 与 apply-comments.mjs 一致：Prisma 脚本不自动读根 .env，这里显式补上。
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const plans = [
  {
    id: 'free',
    name: '体验版',
    priceCents: 0,
    monthlyBaseCredits: 500,
    monthlyBonusCredits: 0,
    maxCreditsPerRun: 50,
    rpm: 10,
    allowedModels: ['deepseek-chat'],
    active: true,
  },
  {
    id: 'standard',
    name: '标准版',
    priceCents: 9900,
    monthlyBaseCredits: 2000,
    monthlyBonusCredits: 2000,
    maxCreditsPerRun: 200,
    rpm: 30,
    allowedModels: ['deepseek-chat', 'deepseek-reasoner'],
    active: true,
  },
  {
    id: 'premium',
    name: '高级版',
    priceCents: 19900,
    monthlyBaseCredits: 4000,
    monthlyBonusCredits: 5000,
    maxCreditsPerRun: 500,
    rpm: 60,
    allowedModels: ['deepseek-chat', 'deepseek-reasoner'],
    active: true,
  },
  {
    id: 'ultimate',
    name: '旗舰版',
    priceCents: 99900,
    monthlyBaseCredits: 20000,
    monthlyBonusCredits: 30000,
    maxCreditsPerRun: 2000,
    rpm: 120,
    allowedModels: ['deepseek-chat', 'deepseek-reasoner'],
    active: true,
  },
];

const prices = [
  { model: 'deepseek-chat', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
  { model: 'deepseek-reasoner', inputMilliCreditsPer1k: 200, outputMilliCreditsPer1k: 800 },
  { model: 'mock', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
];

const prisma = new PrismaClient();
try {
  for (const plan of plans) {
    await prisma.plan.upsert({ where: { id: plan.id }, create: plan, update: plan });
  }
  for (const price of prices) {
    await prisma.modelPrice.upsert({ where: { model: price.model }, create: price, update: price });
  }
  console.log(`已写入 ${plans.length} 个套餐、${prices.length} 条模型价格`);
} finally {
  await prisma.$disconnect();
}
```

- [ ] **Step 3: 在 `apps/bff/package.json` 的 scripts 中加一行**

```json
"db:seed:billing": "node scripts/seed-billing.mjs"
```

并在 dependencies 加 `"ioredis": "^5.4.1"`（也可执行 `pnpm --filter @ai-office/bff add ioredis@^5.4.1`，二选一，避免重复改）。

- [ ] **Step 4: 在 `comments.sql` 末尾追加注释，并把 Step.type 注释补上 notice**

```sql
COMMENT ON COLUMN "Step"."type" IS '步骤类型：think / tool_call / tool_result / artifact / confirm_request / notice';

COMMENT ON TABLE "Plan" IS '套餐表：订阅档位与每月积分额度';
COMMENT ON COLUMN "Plan"."id" IS '套餐 ID：free / standard / premium / ultimate';
COMMENT ON COLUMN "Plan"."name" IS '套餐展示名';
COMMENT ON COLUMN "Plan"."priceCents" IS '展示价格（分），不参与扣费';
COMMENT ON COLUMN "Plan"."monthlyBaseCredits" IS '每周期发放的基础积分';
COMMENT ON COLUMN "Plan"."monthlyBonusCredits" IS '每周期发放的赠送积分';
COMMENT ON COLUMN "Plan"."maxCreditsPerRun" IS '单次运行最大预占/消耗积分';
COMMENT ON COLUMN "Plan"."rpm" IS '每分钟最大运行发起数';
COMMENT ON COLUMN "Plan"."allowedModels" IS '允许调用的模型列表（按优先级）';
COMMENT ON COLUMN "Plan"."active" IS '是否可订阅';
COMMENT ON COLUMN "Plan"."createdAt" IS '创建时间';

COMMENT ON TABLE "Subscription" IS '订阅表：租户当前套餐与计费周期';
COMMENT ON COLUMN "Subscription"."id" IS '订阅 ID';
COMMENT ON COLUMN "Subscription"."tenantId" IS '所属租户 ID，一个租户一条';
COMMENT ON COLUMN "Subscription"."planId" IS '当前套餐 ID';
COMMENT ON COLUMN "Subscription"."status" IS '状态：active / expired / canceled';
COMMENT ON COLUMN "Subscription"."periodStart" IS '当前周期开始（UTC）';
COMMENT ON COLUMN "Subscription"."periodEnd" IS '当前周期结束（UTC），积分到期时间';
COMMENT ON COLUMN "Subscription"."createdAt" IS '创建时间';
COMMENT ON COLUMN "Subscription"."updatedAt" IS '更新时间';

COMMENT ON TABLE "CreditLot" IS '积分批次表：每批积分的来源、余额与到期时间';
COMMENT ON COLUMN "CreditLot"."id" IS '批次 ID';
COMMENT ON COLUMN "CreditLot"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "CreditLot"."source" IS '来源：base / bonus / pack / adjust';
COMMENT ON COLUMN "CreditLot"."granted" IS '发放数量';
COMMENT ON COLUMN "CreditLot"."remaining" IS '剩余可用数量';
COMMENT ON COLUMN "CreditLot"."expiresAt" IS '到期时间；NULL 表示不过期';
COMMENT ON COLUMN "CreditLot"."note" IS '备注（周期标记等）';
COMMENT ON COLUMN "CreditLot"."createdAt" IS '创建时间';

COMMENT ON TABLE "CreditTx" IS '积分流水表：只追加不修改，保留完整审计链';
COMMENT ON COLUMN "CreditTx"."id" IS '流水 ID';
COMMENT ON COLUMN "CreditTx"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "CreditTx"."type" IS '类型：grant / consume / expire / adjust / refund';
COMMENT ON COLUMN "CreditTx"."amount" IS '有符号数量：发放为正，消耗/过期为负';
COMMENT ON COLUMN "CreditTx"."source" IS '来源标记（base/bonus/pack/adjust/usage）';
COMMENT ON COLUMN "CreditTx"."runId" IS '关联运行 ID（结算幂等键，唯一）';
COMMENT ON COLUMN "CreditTx"."note" IS '备注';
COMMENT ON COLUMN "CreditTx"."createdAt" IS '创建时间';

COMMENT ON TABLE "TenantCredit" IS '租户积分汇总表：余额与已预占额度';
COMMENT ON COLUMN "TenantCredit"."tenantId" IS '租户 ID';
COMMENT ON COLUMN "TenantCredit"."balance" IS '未过期未消耗的积分总额（含已预占）';
COMMENT ON COLUMN "TenantCredit"."reserved" IS '进行中运行预占的积分';
COMMENT ON COLUMN "TenantCredit"."updatedAt" IS '更新时间';

COMMENT ON TABLE "CreditHold" IS '积分预占表：运行前锁定额度，结算或失败时释放';
COMMENT ON COLUMN "CreditHold"."runId" IS '运行 ID（主键，天然幂等）';
COMMENT ON COLUMN "CreditHold"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "CreditHold"."amount" IS '预占积分';
COMMENT ON COLUMN "CreditHold"."createdAt" IS '创建时间';
COMMENT ON COLUMN "CreditHold"."expiresAt" IS '兜底清理时间（24 小时）';

COMMENT ON TABLE "UsageRecord" IS '用量记录表：一次运行的模型 token 与折算积分';
COMMENT ON COLUMN "UsageRecord"."id" IS '记录 ID';
COMMENT ON COLUMN "UsageRecord"."runId" IS '运行 ID（唯一，结算幂等键）';
COMMENT ON COLUMN "UsageRecord"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "UsageRecord"."userId" IS '发起用户 ID';
COMMENT ON COLUMN "UsageRecord"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "UsageRecord"."models" IS '按模型的用量 JSON：[{model,input,output}]';
COMMENT ON COLUMN "UsageRecord"."inputTokens" IS '输入 token 合计';
COMMENT ON COLUMN "UsageRecord"."outputTokens" IS '输出 token 合计';
COMMENT ON COLUMN "UsageRecord"."credits" IS '实际结算积分';
COMMENT ON COLUMN "UsageRecord"."status" IS '状态：pending / settled / void';
COMMENT ON COLUMN "UsageRecord"."createdAt" IS '创建时间';
COMMENT ON COLUMN "UsageRecord"."settledAt" IS '结算时间';

COMMENT ON TABLE "ModelPrice" IS '模型价格表：每千 token 的毫积分费率';
COMMENT ON COLUMN "ModelPrice"."model" IS '模型名（与 runtime 上报一致）';
COMMENT ON COLUMN "ModelPrice"."inputMilliCreditsPer1k" IS '输入每千 token 毫积分费率';
COMMENT ON COLUMN "ModelPrice"."outputMilliCreditsPer1k" IS '输出每千 token 毫积分费率';
COMMENT ON COLUMN "ModelPrice"."updatedAt" IS '更新时间';
```

- [ ] **Step 5: `docker-compose.yml` 增加 Redis 服务（固定小版本）**

```yaml
  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
```

并在 `volumes:` 下加 `redis-data:`。

- [ ] **Step 6: `.env.example` 追加**

```bash
# 计费与限流（M5a）
# Redis 用于按租户运行限流；留空则退化为进程内固定窗口（单实例可用）
REDIS_URL=redis://127.0.0.1:6379
# 多模型路由（JSON 数组）；未配置时回退 MODEL_BASE_URL + MODEL_NAME 单模型
# [{"model":"deepseek-chat","baseUrl":"https://api.deepseek.com/v1","apiKeyEnv":"DEEPSEEK_API_KEY"}]
MODEL_PROVIDERS=
# 计费补偿扫描间隔（毫秒），0 表示关闭
BILLING_SWEEP_MS=60000
```

- [ ] **Step 7: 生成客户端并应用 schema**

```bash
pnpm --filter @ai-office/bff db:generate
pnpm --filter @ai-office/bff db:up
pnpm --filter @ai-office/bff db:push
pnpm --filter @ai-office/bff db:seed:billing
```

Expected：`db:push` 输出同步成功与「已应用 N 条中文注释」；`db:seed:billing` 输出「已写入 4 个套餐、3 条模型价格」。若数据库未启动，先确认 `docker compose ps`。

- [ ] **Step 8: 提交**

```bash
git add apps/bff/prisma/schema.prisma apps/bff/prisma/comments.sql apps/bff/scripts/seed-billing.mjs apps/bff/package.json apps/bff/docker-compose.yml .env.example pnpm-lock.yaml
git commit -m "feat(billing): 新增计费数据模型与套餐种子"
```

---

## Task 2: shared 契约（billing DTO、UsageEvent、notice）

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/protocol.test.ts`
- Modify: `packages/shared/src/dto.ts`

- [ ] **Step 1: 先写失败测试（`protocol.test.ts` 末尾追加）**

```ts
it('notice 步骤帧可往返（预算超限提示）', () => {
  const ev: AgentEvent = {
    runId: 'r1',
    seq: 9,
    type: 'notice',
    payload: { code: 'budget_exceeded', message: '本次运行已达到积分预算上限，已停止' },
    ts: 0,
  };
  const out = decodeSseFrames(encodeSse({ event: 'step', data: ev }));
  expect(out).toEqual([{ event: 'step', data: ev }]);
  expect((out[0]!.data as AgentEvent).type).toBe('notice');
});
```

Run: `pnpm --filter @ai-office/shared test`
Expected: FAIL（`type: 'notice'` 不在 `StepType` 中，TS 编译报错或断言失败）。

- [ ] **Step 2: `protocol.ts` 修改**

```ts
export type StepType = 'think' | 'tool_call' | 'tool_result' | 'artifact' | 'confirm_request' | 'notice';

/** `notice` step 的 payload：目前只有预算超限，后续可扩展。 */
export interface NoticePayload {
  code: 'budget_exceeded';
  message: string;
}
```

- [ ] **Step 3: `dto.ts` 追加计费契约（放在文件末尾）**

```ts
// ---------------------------------------------------------------------------
// M5a 计费与网关
// ---------------------------------------------------------------------------

/** 模型价格：每千 token 的毫积分费率（1 积分 = 1000 毫积分）。 */
export interface ModelPriceDto {
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
}

/** BFF 下发给 runtime 的计费约束；缺省时不限预算（仅测试/兼容）。 */
export interface RunBilling {
  maxCredits: number;
  allowedModels: string[];
  prices: Record<string, ModelPriceDto>;
}

/** `usage` SSE 事件的 data：截至当前的累计用量，按模型拆分。 */
export interface UsageEvent {
  input: number;
  output: number;
  models: { model: string; input: number; output: number }[];
}

/** 套餐目录项。 */
export interface PlanDto {
  id: string;
  name: string;
  priceCents: number;
  monthlyBaseCredits: number;
  monthlyBonusCredits: number;
  maxCreditsPerRun: number;
  rpm: number;
  allowedModels: string[];
}

/** `/api/billing/summary` 响应。 */
export interface BillingSummaryDto {
  plan: PlanDto;
  subscription: { status: string; periodStart: string; periodEnd: string };
  /** 可用积分 = balance - reserved。 */
  balance: number;
  reserved: number;
  nextExpiry: { amount: number; expiresAt: string } | null;
}

/** 积分流水项。 */
export interface CreditLedgerItemDto {
  id: string;
  type: string;
  amount: number;
  source: string | null;
  runId: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreditLedgerPageDto {
  items: CreditLedgerItemDto[];
  nextCursor: string | null;
}

/** `/api/billing/usage` 聚合项：key 为日期（YYYY-MM-DD）或模型名。 */
export interface UsageAggregateDto {
  key: string;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}
```

- [ ] **Step 4: `RunRequest` 增加可选字段**

把 `packages/shared/src/dto.ts` 中的 `RunRequest` 改为：

```ts
export interface RunRequest {
  runId: string;
  sessionId: string;
  /** 产物存储 Key 需按租户隔离；BFF 从 JWT 取出后透传给 runtime。 */
  tenantId: string;
  /** 知识库按 tenant_id + user_id 隔离；BFF 从 JWT 的 sub 透传。 */
  userId: string;
  goal: string;
  messages: ChatMessage[];
  /** 预占额度、允许模型与价格；缺省表示不限预算（测试/兼容）。 */
  billing?: RunBilling;
}
```

- [ ] **Step 5: 运行测试与类型检查**

```bash
pnpm --filter @ai-office/shared test
pnpm --filter @ai-office/shared exec tsc --noEmit
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts packages/shared/src/dto.ts
git commit -m "feat(shared): 新增计费契约与预算超限事件"
```

---

## Task 3: runtime 模型网关（model 字段、错误类型、路由 fallback）

**Files:**
- Modify: `apps/agent-runtime/src/model/types.ts`
- Create: `apps/agent-runtime/src/model/errors.ts`
- Modify: `apps/agent-runtime/src/model/openai-compat.ts`
- Modify: `apps/agent-runtime/src/model/mock-gateway.ts`
- Create: `apps/agent-runtime/src/model/routing-gateway.ts`
- Create: `apps/agent-runtime/src/model/routing-gateway.test.ts`
- Modify: `apps/agent-runtime/src/model/create-gateway.ts`
- Modify: `apps/agent-runtime/src/model/create-gateway.test.ts`
- Modify: `apps/agent-runtime/src/model/openai-compat.test.ts`
- Modify: `apps/agent-runtime/src/agent-loop.test.ts`（补 `model` 字段）
- Modify: `apps/agent-runtime/src/server.test.ts`（补 `model` 字段）

- [ ] **Step 1: 先写失败测试 `routing-gateway.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { RoutingGateway } from './routing-gateway';
import { ModelHttpError } from './errors';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

function ok(model: string): ChatResponse {
  return { content: model, toolCalls: [], usage: { input: 1, output: 1 }, model };
}

function gatewayOf(model: string, impl: 'ok' | '429' | '400' | 'network' | '500'): ModelGateway {
  return {
    async chat() {
      if (impl === 'ok') return ok(model);
      if (impl === 'network') throw new TypeError('fetch failed');
      throw new ModelHttpError(Number(impl), model);
    },
  };
}

describe('RoutingGateway', () => {
  it('按 req.models 的顺序选择首个可用模型', async () => {
    let called = '';
    const a: ModelGateway = { async chat() { called = 'a'; return ok('a'); } };
    const b: ModelGateway = { async chat() { called = 'b'; return ok('b'); } };
    const gw = new RoutingGateway([{ model: 'a', gateway: a }, { model: 'b', gateway: b }]);
    const out = await gw.chat({ ...req, models: ['b', 'a'] });
    expect(out.model).toBe('b');
    expect(called).toBe('b');
  });

  it('429/5xx/网络错误切到下一个模型', async () => {
    const gw = new RoutingGateway([
      { model: 'a', gateway: gatewayOf('a', '429') },
      { model: 'b', gateway: gatewayOf('b', '500') },
      { model: 'c', gateway: gatewayOf('c', 'ok') },
    ]);
    const out = await gw.chat({ ...req, models: ['a', 'b', 'c'] });
    expect(out.model).toBe('c');
  });

  it('4xx（非 429）直接失败，不放大错误', async () => {
    let bCalled = false;
    const gw = new RoutingGateway([
      { model: 'a', gateway: gatewayOf('a', '400') },
      { model: 'b', gateway: { async chat() { bCalled = true; return ok('b'); } } },
    ]);
    await expect(gw.chat({ ...req, models: ['a', 'b'] })).rejects.toBeInstanceOf(ModelHttpError);
    expect(bCalled).toBe(false);
  });

  it('允许模型与已注册模型无交集时报错，不静默绕过', async () => {
    const gw = new RoutingGateway([{ model: 'a', gateway: gatewayOf('a', 'ok') }]);
    await expect(gw.chat({ ...req, models: ['mock'] })).rejects.toThrow('model_not_allowed');
  });
});
```

Run: `pnpm --filter @ai-office/agent-runtime exec vitest run src/model/routing-gateway.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: `types.ts` 修改**

```ts
export interface ChatRequest {
  messages: ModelMessage[];
  tools: ToolSchema[];
  /** 本次运行允许的模型（按 BFF 给定优先级）；缺省表示不限制。 */
  models?: string[];
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  /** 实际产出该响应的模型名，用于按模型归集用量。 */
  model: string;
}
```

- [ ] **Step 3: 新建 `errors.ts`**

```ts
/** 模型 HTTP 错误：携带状态码，供路由网关判断是否可 fallback。 */
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly model: string,
  ) {
    super(`model_http_${status}`);
    this.name = 'ModelHttpError';
  }
}
```

- [ ] **Step 4: 新建 `routing-gateway.ts`**

```ts
import type { ChatRequest, ChatResponse, ModelGateway } from './types';
import { ModelHttpError } from './errors';

export interface ModelRoute {
  model: string;
  gateway: ModelGateway;
}

/** 仅网络错误、429、5xx 值得换模型；其余 4xx 多半是参数/鉴权问题，重试只会放大错误。 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ModelHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError;
}

/**
 * 多模型路由：按 req.models 的顺序选择已注册的模型；可重试错误切下一个。
 * 不读写账本——预算与结算都留在 BFF。
 */
export class RoutingGateway implements ModelGateway {
  constructor(private readonly routes: ModelRoute[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const allowed = req.models;
    let candidates = this.routes.filter((r) => !allowed || allowed.includes(r.model));
    if (allowed) {
      const order = new Map(allowed.map((m, i) => [m, i]));
      candidates = [...candidates].sort(
        (a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0),
      );
    }
    if (candidates.length === 0) throw new Error('model_not_allowed');

    let lastErr: unknown;
    for (const route of candidates) {
      try {
        return await route.gateway.chat(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
      }
    }
    throw lastErr;
  }
}
```

- [ ] **Step 5: `openai-compat.ts` 与 `mock-gateway.ts` 补 `model` 并改用 `ModelHttpError`**

`openai-compat.ts`：
- 顶部加 `import { ModelHttpError } from './errors';`
- `if (!res.ok) throw new Error(\`model_http_${res.status}\`);` 改为
  `if (!res.ok) throw new ModelHttpError(res.status, this.cfg.model);`
- 返回值加 `model: this.cfg.model`。

`mock-gateway.ts`：两个 `return { ... }` 都加 `model: 'mock'`。

- [ ] **Step 6: 批量给 runtime 测试桩补 `model: 'mock'`**

```bash
perl -0pi -e "s/(usage: \{ input: \d+, output: \d+ \})/$1, model: 'mock'/g" apps/agent-runtime/src/agent-loop.test.ts apps/agent-runtime/src/server.test.ts
```

检查：`grep -n "usage:" apps/agent-runtime/src/agent-loop.test.ts | head`，每个 `ChatResponse` 都应带 `model: 'mock'`。

`openai-compat.test.ts` 的成功用例断言里加 `model: 'deepseek-chat'`（与配置一致）。

- [ ] **Step 7: 改写 `create-gateway.ts`**

```ts
import type { ModelGateway } from './types';
import { OpenAICompatGateway } from './openai-compat';
import { MockGateway } from './mock-gateway';
import { RoutingGateway } from './routing-gateway';

interface ProviderConfig {
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
}

/** 解析 MODEL_PROVIDERS；格式非法时启动即失败，避免带病运行。 */
export function parseProviders(raw: string | undefined): ProviderConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid_MODEL_PROVIDERS');
  }
  if (!Array.isArray(parsed)) throw new Error('invalid_MODEL_PROVIDERS');
  return parsed.map((item) => {
    if (item === null || typeof item !== 'object') throw new Error('invalid_MODEL_PROVIDERS');
    const p = item as Record<string, unknown>;
    if (typeof p.model !== 'string' || typeof p.baseUrl !== 'string' || typeof p.apiKeyEnv !== 'string') {
      throw new Error('invalid_MODEL_PROVIDERS');
    }
    return { model: p.model, baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv };
  });
}

/**
 * 配置了 MODEL_PROVIDERS 且至少一个 provider 有 key → 多模型路由；
 * 否则沿用单模型配置；完全没有 key → MockGateway（本地/CI）。
 */
export function createGateway(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  const providers = parseProviders(env.MODEL_PROVIDERS).filter((p) => env[p.apiKeyEnv]);
  if (providers.length > 0) {
    return new RoutingGateway(
      providers.map((p) => ({
        model: p.model,
        gateway: new OpenAICompatGateway({
          baseUrl: p.baseUrl,
          apiKey: env[p.apiKeyEnv] as string,
          model: p.model,
        }),
      })),
    );
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return new MockGateway();
  return new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.MODEL_NAME ?? 'deepseek-chat',
  });
}
```

- [ ] **Step 8: `create-gateway.test.ts` 增加两个用例**

```ts
it('MODEL_PROVIDERS 配置有效 key 时返回 RoutingGateway', () => {
  const gw = createGateway({
    MODEL_PROVIDERS: JSON.stringify([
      { model: 'deepseek-chat', baseUrl: 'https://x/v1', apiKeyEnv: 'K1' },
    ]),
    K1: 'sk-1',
  } as NodeJS.ProcessEnv);
  expect(gw.constructor.name).toBe('RoutingGateway');
});

it('MODEL_PROVIDERS 非法 JSON 时启动失败', () => {
  expect(() => createGateway({ MODEL_PROVIDERS: '{bad' } as NodeJS.ProcessEnv)).toThrow(
    'invalid_MODEL_PROVIDERS',
  );
});
```

- [ ] **Step 9: 运行 runtime 全量测试**

```bash
pnpm --filter @ai-office/agent-runtime test
pnpm --filter @ai-office/agent-runtime exec tsc --noEmit
```

Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add apps/agent-runtime/src/model apps/agent-runtime/src/agent-loop.test.ts apps/agent-runtime/src/server.test.ts
git commit -m "feat(runtime): 模型网关支持多模型路由与可重试 fallback"
```

---

## Task 4: runtime 预算执行与按模型用量

**Files:**
- Create: `apps/agent-runtime/src/billing.ts`
- Create: `apps/agent-runtime/src/billing.test.ts`
- Modify: `apps/agent-runtime/src/agent-loop.ts`
- Modify: `apps/agent-runtime/src/agent-loop.test.ts`
- Modify: `apps/agent-runtime/src/server.ts`

- [ ] **Step 1: 先写失败测试 `billing.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { milliCreditsFor, toUsageEvent } from './billing';

const prices = {
  mock: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
  expensive: { inputMilliCreditsPer1k: 2000, outputMilliCreditsPer1k: 2000 },
};

describe('milliCreditsFor', () => {
  it('按模型分别计价并求和', () => {
    const milli = milliCreditsFor(
      [
        { model: 'mock', input: 1000, output: 1000 },
        { model: 'expensive', input: 1000, output: 0 },
      ],
      prices,
    );
    // mock: 100 + 300 = 400；expensive: 2000；合计 2400 毫积分
    expect(milli).toBe(2400);
  });

  it('未知模型按 0 计，不抛错', () => {
    expect(milliCreditsFor([{ model: 'nope', input: 9999, output: 9999 }], prices)).toBe(0);
  });
});

describe('toUsageEvent', () => {
  it('汇总总量并按模型拆分', () => {
    const map = new Map([
      ['mock', { input: 10, output: 8 }],
      ['other', { input: 5, output: 2 }],
    ]);
    expect(toUsageEvent(map)).toEqual({
      input: 15,
      output: 10,
      models: [
        { model: 'mock', input: 10, output: 8 },
        { model: 'other', input: 5, output: 2 },
      ],
    });
  });
});
```

Run: `pnpm --filter @ai-office/agent-runtime exec vitest run src/billing.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 新建 `billing.ts`**

```ts
import type { ModelPriceDto, UsageEvent } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/** 累计用量换算成毫积分：tokens × 毫积分/1K ÷ 1000。 */
export function milliCreditsFor(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
): number {
  let milli = 0;
  for (const m of models) {
    const p = prices[m.model];
    if (!p) continue;
    milli += (m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k) / 1000;
  }
  return milli;
}

/** Map<model, usage> → usage 事件（累计值）。 */
export function toUsageEvent(map: Map<string, { input: number; output: number }>): UsageEvent {
  let input = 0;
  let output = 0;
  const models: ModelUsage[] = [];
  for (const [model, u] of map) {
    input += u.input;
    output += u.output;
    models.push({ model, input: u.input, output: u.output });
  }
  return { input, output, models };
}
```

- [ ] **Step 3: 在 `agent-loop.test.ts` 增加预算用例（先失败）**

```ts
it('超出积分预算时发 notice 并停止，且不再调用模型', async () => {
  let calls = 0;
  const gateway: ModelGateway = {
    async chat() {
      calls++;
      return {
        content: '继续',
        toolCalls: [{ id: 'c', name: 'web.search', args: { query: 'x' } }],
        usage: { input: 1000, output: 0 },
        model: 'mock',
      };
    },
  };
  const events = await collect(
    runAgent(req, {
      gateway,
      tools: [echoTool],
      billing: {
        maxCredits: 1,
        allowedModels: ['mock'],
        prices: { mock: { inputMilliCreditsPer1k: 2000, outputMilliCreditsPer1k: 0 } },
      },
    }),
  );
  expect(calls).toBe(1);
  const notice = events.find((e) => e.type === 'notice');
  expect(notice?.payload).toMatchObject({ code: 'budget_exceeded' });
});
```

Run: `pnpm --filter @ai-office/agent-runtime exec vitest run src/agent-loop.test.ts`
Expected: FAIL（`billing` 不在 `RunDeps`，且不会发 notice）。

- [ ] **Step 4: 修改 `agent-loop.ts`**

`RunDeps`：

```ts
import type { RunBilling, UsageEvent } from '@ai-office/shared';
import { milliCreditsFor, toUsageEvent } from './billing';

export interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;
  onUsage?: (usage: UsageEvent) => void;
  confirm?: ConfirmGate;
  confirmTimeoutMs?: number;
  /** 预占额度、允许模型与价格；缺省时不限预算。 */
  billing?: RunBilling;
}
```

循环内改为：

```ts
  let seq = 0;
  const usageByModel = new Map<string, { input: number; output: number }>();
  ...
  for (let round = 0; round < maxRounds; round++) {
    // 预算在发起下一轮之前判断：超限立即刹车，不再浪费一次模型调用。
    if (round > 0 && deps.billing) {
      const milli = milliCreditsFor(
        [...usageByModel].map(([model, u]) => ({ model, ...u })),
        deps.billing.prices,
      );
      if (milli >= deps.billing.maxCredits * 1000) {
        yield step('notice', {
          code: 'budget_exceeded',
          message: '本次运行已达到积分预算上限，已停止',
        });
        break;
      }
    }

    const resp = await deps.gateway.chat({
      messages,
      tools: schemas,
      models: deps.billing?.allowedModels,
    });
    const prev = usageByModel.get(resp.model) ?? { input: 0, output: 0 };
    usageByModel.set(resp.model, {
      input: prev.input + resp.usage.input,
      output: prev.output + resp.usage.output,
    });
```

结尾 `deps.onUsage?.(usage)` 改为 `deps.onUsage?.(toUsageEvent(usageByModel));`，并删除原来的 `let usage = ...` 与累加行。

- [ ] **Step 5: 修正 `agent-loop.test.ts` 中旧的 usage 断言**

把 `expect(usages).toEqual([{ input: 3, output: 3 }]);` 改为：

```ts
expect(usages).toEqual([
  { input: 3, output: 3, models: [{ model: 'mock', input: 3, output: 3 }] },
]);
```

- [ ] **Step 6: `server.ts` 透传 billing**

在 `runAgent(runReq, { ... })` 中加：

```ts
billing: runReq.billing,
```

`onUsage` 保持不变（`u` 现在是 `UsageEvent`）。

- [ ] **Step 7: 运行测试**

```bash
pnpm --filter @ai-office/agent-runtime test
pnpm --filter @ai-office/agent-runtime exec tsc --noEmit
```

Expected: PASS。若其他用例因 `onUsage` 结构断言失败，统一改为 `toMatchObject` 或补 `models`。

- [ ] **Step 8: 提交**

```bash
git add apps/agent-runtime/src/billing.ts apps/agent-runtime/src/billing.test.ts apps/agent-runtime/src/agent-loop.ts apps/agent-runtime/src/agent-loop.test.ts apps/agent-runtime/src/server.ts
git commit -m "feat(runtime): 按模型累计用量并按积分预算硬停"
```

---

## Task 5: BFF 计费纯函数（积分换算、批次扣减、用量聚合）

**Files:**
- Create: `apps/bff/src/billing/credits.ts`
- Create: `apps/bff/src/billing/credits.test.ts`
- Create: `apps/bff/src/billing/lots.ts`
- Create: `apps/bff/src/billing/lots.test.ts`
- Create: `apps/bff/src/billing/usage.ts`
- Create: `apps/bff/src/billing/usage.test.ts`

- [ ] **Step 1: 写 `credits.test.ts`（先失败）**

```ts
import { describe, it, expect } from 'vitest';
import { computeCredits } from './credits';

const prices = {
  chat: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
};

describe('computeCredits', () => {
  it('4000 token 约 1 积分', () => {
    expect(computeCredits([{ model: 'chat', input: 4000, output: 0 }], prices, 100)).toBe(1);
  });

  it('结果向上取整', () => {
    // 输入 1000 + 输出 1000 = 400 毫积分 → 0.4 → 1
    expect(computeCredits([{ model: 'chat', input: 1000, output: 1000 }], prices, 100)).toBe(1);
    // 输入 10000 + 输出 10000 = 4000 毫积分 → 4
    expect(computeCredits([{ model: 'chat', input: 10000, output: 10000 }], prices, 100)).toBe(4);
  });

  it('最低 1 积分', () => {
    expect(computeCredits([{ model: 'chat', input: 1, output: 0 }], prices, 100)).toBe(1);
  });

  it('封顶在 cap', () => {
    expect(computeCredits([{ model: 'chat', input: 1_000_000, output: 0 }], prices, 7)).toBe(7);
  });

  it('未知模型不计价但仍有最低 1 积分', () => {
    expect(computeCredits([{ model: 'nope', input: 9999, output: 9999 }], prices, 100)).toBe(1);
  });
});
```

- [ ] **Step 2: 新建 `credits.ts`**

```ts
import type { ModelPriceDto } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/**
 * 积分 = ceil(Σ tokens × 毫积分/1K ÷ 1000 ÷ 1000)，最低 1，封顶 cap。
 * 全程整数累计后再除，避免浮点误差。
 */
export function computeCredits(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
  cap: number,
): number {
  let scaled = 0;
  for (const m of models) {
    const p = prices[m.model];
    if (!p) continue;
    scaled += m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k;
  }
  const credits = Math.max(1, Math.ceil(scaled / 1_000_000));
  return Math.min(credits, Math.max(1, cap));
}
```

Run: `pnpm --filter @ai-office/bff exec vitest run src/billing/credits.test.ts` → PASS。

- [ ] **Step 3: 写 `lots.test.ts`（先失败）**

```ts
import { describe, it, expect } from 'vitest';
import { sortLots, allocate } from './lots';

const d = (s: string) => new Date(s);

describe('sortLots', () => {
  it('最早到期优先；同到期 base → bonus → pack；NULL 最后', () => {
    const lots = [
      { id: 'pack', source: 'pack', remaining: 10, expiresAt: d('2026-11-01') },
      { id: 'never', source: 'adjust', remaining: 10, expiresAt: null },
      { id: 'bonus', source: 'bonus', remaining: 10, expiresAt: d('2026-12-01') },
      { id: 'base', source: 'base', remaining: 10, expiresAt: d('2026-12-01') },
      { id: 'early', source: 'base', remaining: 10, expiresAt: d('2026-10-20') },
    ];
    expect(sortLots(lots).map((l) => l.id)).toEqual(['early', 'base', 'bonus', 'pack', 'never']);
  });
});

describe('allocate', () => {
  it('按顺序扣减并返回明细', () => {
    const lots = [
      { id: 'b', source: 'base', remaining: 5, expiresAt: d('2026-12-01') },
      { id: 'a', source: 'base', remaining: 5, expiresAt: d('2026-10-20') },
    ];
    expect(allocate(lots, 7)).toEqual({
      allocations: [
        { lotId: 'a', amount: 5 },
        { lotId: 'b', amount: 2 },
      ],
      deducted: 7,
    });
  });

  it('余额不足时按可用额度扣减', () => {
    expect(
      allocate([{ id: 'a', source: 'base', remaining: 3, expiresAt: null }], 10),
    ).toEqual({ allocations: [{ lotId: 'a', amount: 3 }], deducted: 3 });
  });
});
```

- [ ] **Step 4: 新建 `lots.ts`**

```ts
export interface LotLike {
  id: string;
  source: string;
  remaining: number;
  expiresAt: Date | null;
}

const SOURCE_ORDER: Record<string, number> = { base: 0, bonus: 1, pack: 2 };

/** 扣减顺序：最早到期优先；NULL 视为永不过期排最后；同到期 base → bonus → pack → 其他。 */
export function sortLots<T extends LotLike>(lots: T[]): T[] {
  return [...lots].sort((a, b) => {
    const ax = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY;
    const bx = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY;
    if (ax !== bx) return ax - bx;
    const ao = SOURCE_ORDER[a.source] ?? 3;
    const bo = SOURCE_ORDER[b.source] ?? 3;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

export interface LotAllocation {
  lotId: string;
  amount: number;
}

/** 从批次中扣减 amount；返回逐批明细与实际扣减总额（不足时按可用额度封顶）。 */
export function allocate(
  lots: LotLike[],
  amount: number,
): { allocations: LotAllocation[]; deducted: number } {
  let left = Math.max(0, amount);
  const allocations: LotAllocation[] = [];
  for (const lot of sortLots(lots)) {
    if (left <= 0) break;
    if (lot.remaining <= 0) continue;
    const take = Math.min(lot.remaining, left);
    allocations.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return { allocations, deducted: Math.max(0, amount) - left };
}
```

Run: `pnpm --filter @ai-office/bff exec vitest run src/billing/lots.test.ts` → PASS。

- [ ] **Step 5: 写 `usage.test.ts`（先失败）**

```ts
import { describe, it, expect } from 'vitest';
import { parseUsageEvent, parseModels, aggregateUsage } from './usage';

const prices = { chat: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 } };

describe('parseUsageEvent', () => {
  it('合法结构原样解析', () => {
    expect(
      parseUsageEvent({ input: 3, output: 2, models: [{ model: 'chat', input: 3, output: 2 }] }),
    ).toEqual({ input: 3, output: 2, models: [{ model: 'chat', input: 3, output: 2 }] });
  });
  it('非法结构返回 null', () => {
    expect(parseUsageEvent({ input: 3 })).toBeNull();
    expect(parseUsageEvent(null)).toBeNull();
  });
});

describe('parseModels', () => {
  it('过滤非法项', () => {
    expect(parseModels([{ model: 'a', input: 1, output: 2 }, { model: 1 }, null])).toEqual([
      { model: 'a', input: 1, output: 2 },
    ]);
  });
});

describe('aggregateUsage', () => {
  const rows = [
    {
      createdAt: new Date('2026-10-18T10:00:00Z'),
      credits: 2,
      inputTokens: 10,
      outputTokens: 5,
      models: [{ model: 'chat', input: 10, output: 5 }],
    },
    {
      createdAt: new Date('2026-10-18T12:00:00Z'),
      credits: 1,
      inputTokens: 20,
      outputTokens: 10,
      models: [{ model: 'chat', input: 20, output: 10 }],
    },
  ];

  it('按日聚合', () => {
    expect(aggregateUsage(rows, 'day', prices)).toEqual([
      { key: '2026-10-18', credits: 3, inputTokens: 30, outputTokens: 15, runs: 2 },
    ]);
  });

  it('按模型聚合，积分由模型用量单独折算', () => {
    expect(aggregateUsage(rows, 'model', prices)).toEqual([
      { key: 'chat', credits: 1, inputTokens: 30, outputTokens: 15, runs: 2 },
    ]);
  });
});
```

按模型期望：30*100 + 15*300 = 3000+4500=7500（scaled），/1e6 → 0.0075 → ceil = 1。对。

- [ ] **Step 6: 新建 `usage.ts`**

```ts
import type { UsageAggregateDto, UsageEvent } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/** 校验并解析 runtime 的 usage 事件；非法结构返回 null（不扣费）。 */
export function parseUsageEvent(data: unknown): UsageEvent | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.input !== 'number' || typeof d.output !== 'number' || !Array.isArray(d.models)) {
    return null;
  }
  return { input: d.input, output: d.output, models: parseModels(d.models) };
}

/** 从 JSON 字段提取模型用量，过滤非法项。 */
export function parseModels(raw: unknown): ModelUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelUsage[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.model !== 'string' || typeof m.input !== 'number' || typeof m.output !== 'number') {
      continue;
    }
    out.push({ model: m.model, input: m.input, output: m.output });
  }
  return out;
}

export interface UsageRow {
  createdAt: Date;
  credits: number | null;
  inputTokens: number;
  outputTokens: number;
  models: unknown;
}

/**
 * 用量聚合：按日时 credits 取结算值；按模型时用价格表单独折算
 * （不做“最低 1 积分”，否则每个模型都会被抬高）。
 */
export function aggregateUsage(
  rows: UsageRow[],
  groupBy: 'day' | 'model',
  prices: Record<string, { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number }>,
): UsageAggregateDto[] {
  const acc = new Map<string, UsageAggregateDto>();
  const add = (key: string, credits: number, input: number, output: number) => {
    const cur = acc.get(key) ?? { key, credits: 0, inputTokens: 0, outputTokens: 0, runs: 0 };
    cur.credits += credits;
    cur.inputTokens += input;
    cur.outputTokens += output;
    cur.runs += 1;
    acc.set(key, cur);
  };

  for (const row of rows) {
    if (groupBy === 'day') {
      add(row.createdAt.toISOString().slice(0, 10), row.credits ?? 0, row.inputTokens, row.outputTokens);
    } else {
      for (const m of parseModels(row.models)) {
        const p = prices[m.model];
        const scaled = p ? m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k : 0;
        add(m.model, Math.ceil(scaled / 1_000_000), m.input, m.output);
      }
    }
  }
  return [...acc.values()].sort((a, b) => a.key.localeCompare(b.key));
}
```

Run: `pnpm --filter @ai-office/bff exec vitest run src/billing` → PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/bff/src/billing/credits.ts apps/bff/src/billing/credits.test.ts apps/bff/src/billing/lots.ts apps/bff/src/billing/lots.test.ts apps/bff/src/billing/usage.ts apps/bff/src/billing/usage.test.ts
git commit -m "feat(billing): 新增积分换算、批次扣减与用量聚合"
```

---

## Task 6: BFF BillingService 核心（预占 / 结算 / 过期 / 查询）

**Files:**
- Create: `apps/bff/src/billing/billing.errors.ts`
- Create: `apps/bff/src/billing/billing.rate-limit.ts`（内容见 Task 7 Step 2，Step 3.5 创建）
- Create: `apps/bff/src/billing/billing.service.ts`
- Create: `apps/bff/src/billing/billing.service.test.ts`

- [ ] **Step 1: 新建错误类型 `billing.errors.ts`**

```ts
/** 可用积分不足（映射 402）。 */
export class InsufficientCreditsError extends Error {
  constructor() {
    super('insufficient_credits');
    this.name = 'InsufficientCreditsError';
  }
}

/** 套餐过期（映射 402）。 */
export class PlanExpiredError extends Error {
  constructor() {
    super('plan_expired');
    this.name = 'PlanExpiredError';
  }
}

/** 运行频率超限（映射 429）。 */
export class RateLimitedError extends Error {
  constructor(readonly retryAfter: number) {
    super('rate_limited');
    this.name = 'RateLimitedError';
  }
}
```

- [ ] **Step 2: 写 `billing.service.test.ts`（先失败；包含内存版 Prisma）**

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { BillingService } from './billing.service';
import { InsufficientCreditsError } from './billing.errors';
import { PrismaService } from '../db/prisma.service';

type Row = Record<string, any>;

const NOW = new Date('2026-10-19T08:00:00Z');

function makeDb() {
  const db = {
    plans: [] as Row[],
    subs: [] as Row[],
    lots: [] as Row[],
    txs: [] as Row[],
    credits: [] as Row[],
    holds: [] as Row[],
    usages: [] as Row[],
    prices: [] as Row[],
  };

  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else if (v && typeof v === 'object' && 'decrement' in v) row[k] = (row[k] ?? 0) - (v as any).decrement;
      else row[k] = v;
    }
    return row;
  };

  const client: any = {
    plan: {
      findUnique: async ({ where }: any) => db.plans.find((p) => p.id === where.id) ?? null,
      findMany: async () => [...db.plans].filter((p) => p.active).sort((a, b) => a.priceCents - b.priceCents),
    },
    subscription: {
      findUnique: async ({ where }: any) => {
        const sub = db.subs.find((s) => s.tenantId === where.tenantId);
        return sub ? { ...sub, plan: db.plans.find((p) => p.id === sub.planId) } : null;
      },
      create: async ({ data }: any) => {
        if (db.subs.some((s) => s.tenantId === data.tenantId)) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `sub${db.subs.length + 1}`, ...data };
        db.subs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => apply(db.subs.find((s) => s.tenantId === where.tenantId)!, data),
      updateMany: async ({ where, data }: any) => {
        const targets = db.subs.filter(
          (s) => s.tenantId === where.tenantId && (!where.periodEnd?.lte || s.periodEnd <= where.periodEnd.lte),
        );
        targets.forEach((s) => apply(s, data));
        return { count: targets.length };
      },
    },
    tenantCredit: {
      upsert: async ({ where, create }: any) => {
        let row = db.credits.find((c) => c.tenantId === where.tenantId);
        if (!row) {
          row = { balance: 0, reserved: 0, ...create };
          db.credits.push(row);
        }
        return row;
      },
      findUnique: async ({ where }: any) => db.credits.find((c) => c.tenantId === where.tenantId) ?? null,
      update: async ({ where, data }: any) => apply(db.credits.find((c) => c.tenantId === where.tenantId)!, data),
    },
    creditLot: {
      create: async ({ data }: any) => {
        const row = { id: `lot${db.lots.length + 1}`, ...data };
        db.lots.push(row);
        return row;
      },
      findMany: async ({ where }: any) =>
        db.lots.filter(
          (l) =>
            l.tenantId === where.tenantId &&
            (!where.remaining?.gt || l.remaining > where.remaining.gt) &&
            (!where.expiresAt?.lte || (l.expiresAt && l.expiresAt <= where.expiresAt.lte)),
        ),
      findFirst: async ({ where }: any) => {
        const rows = db.lots
          .filter((l) => l.tenantId === where.tenantId)
          .filter((l) => !where.remaining?.gt || l.remaining > where.remaining.gt)
          .filter((l) => where.expiresAt?.not !== null || l.expiresAt != null);
        rows.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
        return rows[0] ?? null;
      },
      update: async ({ where, data }: any) => apply(db.lots.find((l) => l.id === where.id)!, data),
    },
    creditTx: {
      create: async ({ data }: any) => {
        const row = { id: `tx${db.txs.length + 1}`, createdAt: NOW, ...data };
        db.txs.push(row);
        return row;
      },
      findMany: async () => [...db.txs],
      findUnique: async ({ where }: any) =>
        db.txs.find((t) => (where.id ? t.id === where.id : t.runId === where.runId)) ?? null,
    },
    creditHold: {
      create: async ({ data }: any) => {
        const row = { createdAt: NOW, ...data };
        db.holds.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => db.holds.find((h) => h.runId === where.runId) ?? null,
      findMany: async ({ where }: any) =>
        db.holds.filter((h) => !where?.expiresAt?.lte || h.expiresAt <= where.expiresAt.lte),
      delete: async ({ where }: any) => {
        const idx = db.holds.findIndex((h) => h.runId === where.runId);
        if (idx >= 0) db.holds.splice(idx, 1);
        return {};
      },
    },
    usageRecord: {
      findUnique: async ({ where }: any) => db.usages.find((u) => u.runId === where.runId) ?? null,
      findMany: async () => [...db.usages],
      create: async ({ data }: any) => {
        const row = { id: `u${db.usages.length + 1}`, createdAt: NOW, credits: null, settledAt: null, ...data };
        db.usages.push(row);
        return row;
      },
      update: async ({ where, data }: any) => apply(db.usages.find((u) => u.runId === where.runId)!, data),
    },
    modelPrice: { findMany: async () => [...db.prices] },
    run: { findUnique: async () => ({ status: 'succeeded' }) },
    $queryRaw: async () => [],
    $transaction: async (fn: any) => fn(client),
  };

  return { db, prisma: client as unknown as PrismaService };
}

const limiter = { hit: async () => ({ allowed: true, retryAfter: 0 }) };

function seed(db: ReturnType<typeof makeDb>['db']) {
  db.plans.push({
    id: 'free',
    name: '体验版',
    priceCents: 0,
    monthlyBaseCredits: 500,
    monthlyBonusCredits: 0,
    maxCreditsPerRun: 50,
    rpm: 10,
    allowedModels: ['mock'],
    active: true,
  });
  db.prices.push({ model: 'mock', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 });
}

let ctx: ReturnType<typeof makeDb>;
let svc: BillingService;

beforeEach(() => {
  ctx = makeDb();
  seed(ctx.db);
  svc = new BillingService(ctx.prisma, limiter as any);
});

describe('BillingService', () => {
  it('首次访问懒建 free 订阅并发放 500 积分', async () => {
    const summary = await svc.summary('t1');
    expect(summary.balance).toBe(500);
    expect(summary.plan.id).toBe('free');
    expect(ctx.db.lots).toHaveLength(1);
    expect(ctx.db.txs[0]).toMatchObject({ type: 'grant', amount: 500, source: 'base' });
  });

  it('beginRun 预占不超过单次上限，余额为 0 时抛 InsufficientCreditsError', async () => {
    await svc.summary('t1');
    const billing = await svc.beginRun('r1', 't1');
    expect(billing.maxCredits).toBe(50);
    expect(ctx.db.credits[0].reserved).toBe(50);

    ctx.db.credits[0].balance = 50; // 剩余 0 可用
    await expect(svc.beginRun('r2', 't1')).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('settle 按用量扣费、写 consume 流水并释放预占；重复调用幂等', async () => {
    await svc.summary('t1');
    await svc.beginRun('r1', 't1');
    await svc.recordUsage(
      'r1',
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      { input: 1000, output: 1000, models: [{ model: 'mock', input: 1000, output: 1000 }] },
    );
    await svc.settle('r1');

    // 1000×100 + 1000×300 = 400000 → 0.4 → 1 积分
    expect(ctx.db.credits[0].balance).toBe(499);
    expect(ctx.db.credits[0].reserved).toBe(0);
    expect(ctx.db.holds).toHaveLength(0);
    expect(ctx.db.usages[0]).toMatchObject({ status: 'settled', credits: 1 });
    expect(ctx.db.txs.filter((t) => t.type === 'consume')).toHaveLength(1);

    await svc.settle('r1');
    expect(ctx.db.credits[0].balance).toBe(499);
  });

  it('releaseHold 归还预占', async () => {
    await svc.summary('t1');
    await svc.beginRun('r1', 't1');
    await svc.releaseHold('r1');
    expect(ctx.db.credits[0].reserved).toBe(0);
    expect(ctx.db.holds).toHaveLength(0);
  });

  it('sweepExpired 清零过期批次并写 expire 流水', async () => {
    await svc.summary('t1');
    ctx.db.lots[0].expiresAt = new Date('2026-10-18T00:00:00Z');
    await svc.sweepExpired(NOW);
    expect(ctx.db.lots[0].remaining).toBe(0);
    expect(ctx.db.credits[0].balance).toBe(0);
    expect(ctx.db.txs.some((t) => t.type === 'expire' && t.amount === -500)).toBe(true);
  });

  it('adjust 支持发放与收回，收回不得使可用余额为负', async () => {
    await svc.summary('t1');
    await svc.adjust('t1', 100, '补偿', null);
    expect(ctx.db.credits[0].balance).toBe(600);
    await svc.adjust('t1', -600, '收回', null);
    expect(ctx.db.credits[0].balance).toBe(0);
    await expect(svc.adjust('t1', -1, '收回', null)).rejects.toThrow('insufficient_balance');
  });
});
```

Run: `pnpm --filter @ai-office/bff exec vitest run src/billing/billing.service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 新建 `billing.service.ts`（完整实现）**

```ts
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan, Subscription } from '@prisma/client';
import type {
  BillingSummaryDto,
  CreditLedgerPageDto,
  PlanDto,
  RunBilling,
  UsageAggregateDto,
  UsageEvent,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { allocate } from './lots';
import { computeCredits } from './credits';
import { aggregateUsage, parseModels } from './usage';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from './billing.errors';
import { RATE_LIMITER, type RateLimiter } from './billing.rate-limit';

type Db = Prisma.TransactionClient;

const HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** 当前自然月（UTC）：月初到下月月初。 */
export function currentPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** 从 now 起一个月（UTC），用于管理员开通付费套餐。 */
function addMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()));
}

function toPlanDto(p: Plan): PlanDto {
  return {
    id: p.id,
    name: p.name,
    priceCents: p.priceCents,
    monthlyBaseCredits: p.monthlyBaseCredits,
    monthlyBonusCredits: p.monthlyBonusCredits,
    maxCreditsPerRun: p.maxCreditsPerRun,
    rpm: p.rpm,
    allowedModels: p.allowedModels,
  };
}

/**
 * 计费核心：套餐、授信、预占、结算、过期与查询。
 * 所有入口先 ensureSubscription（懒建/续期），保证存量租户无需迁移脚本。
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  // ------------------------------------------------------------------ 套餐与发放
  async ensureSubscription(tenantId: string): Promise<{ plan: Plan; sub: Subscription }> {
    const now = new Date();
    const existing = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!existing) return this.createFreeSubscription(tenantId, now);

    if (existing.periodEnd.getTime() > now.getTime()) return { plan: existing.plan, sub: existing };

    if (existing.planId !== 'free') {
      // 付费套餐过期：不自动续期，保留记录供用户查看。
      if (existing.status !== 'expired') {
        await this.prisma.subscription.update({ where: { tenantId }, data: { status: 'expired' } });
      }
      return { plan: existing.plan, sub: { ...existing, status: 'expired' } };
    }

    // free 自动续期：条件更新保证并发下只有一方发放。
    const { start, end } = currentPeriod(now);
    const renewed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.subscription.updateMany({
        where: { tenantId, periodEnd: { lte: now } },
        data: { status: 'active', periodStart: start, periodEnd: end },
      });
      if (res.count === 0) return null;
      await this.grantPeriod(tx, tenantId, existing.plan, start, end);
      return tx.subscription.findUnique({ where: { tenantId } });
    });
    if (renewed) return { plan: existing.plan, sub: renewed };
    const again = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    return again ? { plan: again.plan, sub: again } : { plan: existing.plan, sub: existing };
  }

  private async createFreeSubscription(
    tenantId: string,
    now: Date,
  ): Promise<{ plan: Plan; sub: Subscription }> {
    const plan = await this.requirePlan('free');
    const { start, end } = currentPeriod(now);
    try {
      const sub = await this.prisma.$transaction(async (tx) => {
        const created = await tx.subscription.create({
          data: { tenantId, planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
        });
        await this.grantPeriod(tx, tenantId, plan, start, end);
        return created;
      });
      return { plan, sub };
    } catch (err) {
      // 并发首次访问：另一方已创建并发放，直接回读。
      if ((err as { code?: string }).code === 'P2002') {
        const sub = await this.prisma.subscription.findUnique({
          where: { tenantId },
          include: { plan: true },
        });
        if (sub) return { plan: sub.plan, sub };
      }
      throw err;
    }
  }

  /** 发放一个周期的 base/bonus 积分，并累加租户余额。 */
  private async grantPeriod(
    tx: Db,
    tenantId: string,
    plan: Plan,
    start: Date,
    end: Date,
  ): Promise<void> {
    const grants = [
      { source: 'base', amount: plan.monthlyBaseCredits },
      { source: 'bonus', amount: plan.monthlyBonusCredits },
    ].filter((g) => g.amount > 0);
    if (grants.length === 0) return;

    let total = 0;
    for (const g of grants) {
      await tx.creditLot.create({
        data: {
          tenantId,
          source: g.source,
          granted: g.amount,
          remaining: g.amount,
          expiresAt: end,
          note: `period:${start.toISOString()}`,
        },
      });
      await tx.creditTx.create({
        data: { tenantId, type: 'grant', amount: g.amount, source: g.source, note: `period:${start.toISOString()}` },
      });
      total += g.amount;
    }
    await tx.tenantCredit.upsert({
      where: { tenantId },
      create: { tenantId, balance: total },
      update: { balance: { increment: total } },
    });
  }

  private async requirePlan(id: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new Error(`plan_missing:${id}`);
    return plan;
  }

  // ------------------------------------------------------------------ 预占与结算
  /** 运行前：校验套餐/限流/余额，锁行预占额度。返回给 runtime 的计费约束。 */
  async beginRun(runId: string, tenantId: string): Promise<RunBilling> {
    const { plan, sub } = await this.ensureSubscription(tenantId);
    if (sub.status !== 'active' || sub.periodEnd.getTime() <= Date.now()) {
      throw new PlanExpiredError();
    }
    const rl = await this.limiter.hit(`run:${tenantId}`, plan.rpm);
    if (!rl.allowed) throw new RateLimitedError(rl.retryAfter);

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
      await this.lockCredit(tx, tenantId);
      await this.expireDueLots(tx, tenantId, now);
      const credit = await tx.tenantCredit.findUnique({ where: { tenantId } });
      const available = (credit?.balance ?? 0) - (credit?.reserved ?? 0);
      if (available < 1) throw new InsufficientCreditsError();

      const amount = Math.min(plan.maxCreditsPerRun, available);
      await tx.creditHold.create({
        data: { runId, tenantId, amount, expiresAt: new Date(now.getTime() + HOLD_TTL_MS) },
      });
      await tx.tenantCredit.update({
        where: { tenantId },
        data: { reserved: { increment: amount } },
      });
      return {
        maxCredits: amount,
        allowedModels: plan.allowedModels,
        prices: await this.loadPrices(tx),
      };
    });
  }

  /** 记录累计用量；已存在则仅在 pending 时更新（保持幂等）。 */
  async recordUsage(
    runId: string,
    meta: { tenantId: string; userId: string; sessionId: string },
    usage: UsageEvent,
  ): Promise<void> {
    const data = {
      models: usage.models as unknown as Prisma.InputJsonValue,
      inputTokens: usage.input,
      outputTokens: usage.output,
      status: 'pending',
    };
    const existing = await this.prisma.usageRecord.findUnique({ where: { runId } });
    if (existing) {
      if (existing.status === 'pending') {
        await this.prisma.usageRecord.update({ where: { runId }, data });
      }
      return;
    }
    await this.prisma.usageRecord.create({ data: { runId, ...meta, ...data } });
  }

  /** 结算：按价格折算积分，按到期顺序扣批次，释放预占；runId 唯一保证幂等。 */
  async settle(runId: string): Promise<void> {
    const usage = await this.prisma.usageRecord.findUnique({ where: { runId } });
    if (!usage || usage.status !== 'pending') return;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({
        where: { tenantId: usage.tenantId },
        create: { tenantId: usage.tenantId },
        update: {},
      });
      await this.lockCredit(tx, usage.tenantId);

      const hold = await tx.creditHold.findUnique({ where: { runId } });
      const models = parseModels(usage.models);
      const prices = await this.loadPrices(tx);
      // 有 hold 时封顶在预占额度；无 hold（异常兜底）则按实际用量。
      const credits = computeCredits(models, prices, hold?.amount ?? Number.MAX_SAFE_INTEGER);

      const now = new Date();
      await this.expireDueLots(tx, usage.tenantId, now);
      const lots = await tx.creditLot.findMany({
        where: { tenantId: usage.tenantId, remaining: { gt: 0 } },
      });
      const { allocations, deducted } = allocate(lots, credits);
      for (const a of allocations) {
        await tx.creditLot.update({
          where: { id: a.lotId },
          data: { remaining: { decrement: a.amount } },
        });
      }
      await tx.creditTx.create({
        data: {
          tenantId: usage.tenantId,
          type: 'consume',
          amount: -deducted,
          source: 'usage',
          runId,
          note: `run:${runId}`,
        },
      });
      await tx.tenantCredit.update({
        where: { tenantId: usage.tenantId },
        data: {
          balance: { decrement: deducted },
          ...(hold ? { reserved: { decrement: hold.amount } } : {}),
        },
      });
      if (hold) await tx.creditHold.delete({ where: { runId } });
      await tx.usageRecord.update({
        where: { runId },
        data: { credits: deducted, status: 'settled', settledAt: now },
      });
      if (deducted < credits) {
        console.warn(`[billing] run ${runId} 可用积分不足：应扣 ${credits}，实扣 ${deducted}`);
      }
    });
  }

  /** 运行失败/无用量：只归还预占，不扣费。 */
  async releaseHold(runId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({ where: { runId } });
      if (!hold) return;
      await tx.tenantCredit.upsert({
        where: { tenantId: hold.tenantId },
        create: { tenantId: hold.tenantId },
        update: {},
      });
      await this.lockCredit(tx, hold.tenantId);
      await tx.tenantCredit.update({
        where: { tenantId: hold.tenantId },
        data: { reserved: { decrement: hold.amount } },
      });
      await tx.creditHold.delete({ where: { runId } });
    });
  }

  // ------------------------------------------------------------------ 查询
  async listPlans(): Promise<PlanDto[]> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      orderBy: { priceCents: 'asc' },
    });
    return plans.map(toPlanDto);
  }

  async summary(tenantId: string): Promise<BillingSummaryDto> {
    const { plan, sub } = await this.ensureSubscription(tenantId);
    const credit = await this.prisma.tenantCredit.findUnique({ where: { tenantId } });
    const next = await this.prisma.creditLot.findFirst({
      where: { tenantId, remaining: { gt: 0 }, expiresAt: { not: null } },
      orderBy: { expiresAt: 'asc' },
    });
    return {
      plan: toPlanDto(plan),
      subscription: {
        status: sub.status,
        periodStart: sub.periodStart.toISOString(),
        periodEnd: sub.periodEnd.toISOString(),
      },
      balance: Math.max(0, (credit?.balance ?? 0) - (credit?.reserved ?? 0)),
      reserved: credit?.reserved ?? 0,
      nextExpiry: next?.expiresAt
        ? { amount: next.remaining, expiresAt: next.expiresAt.toISOString() }
        : null,
    };
  }

  async ledger(tenantId: string, limit: number, cursor?: string): Promise<CreditLedgerPageDto> {
    const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    const cursorRow = cursor
      ? await this.prisma.creditTx.findUnique({ where: { id: cursor } })
      : null;
    const rows = await this.prisma.creditTx.findMany({
      where: {
        tenantId,
        ...(cursorRow
          ? {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const items = rows.slice(0, take).map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      source: t.source,
      runId: t.runId,
      note: t.note,
      createdAt: t.createdAt.toISOString(),
    }));
    return {
      items,
      nextCursor: rows.length > take ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async usage(
    tenantId: string,
    from: Date,
    to: Date,
    groupBy: 'day' | 'model',
  ): Promise<UsageAggregateDto[]> {
    const rows = await this.prisma.usageRecord.findMany({
      where: { tenantId, status: 'settled', createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'asc' },
    });
    return aggregateUsage(
      rows.map((r) => ({
        createdAt: r.createdAt,
        credits: r.credits,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        models: r.models,
      })),
      groupBy,
      await this.loadPrices(this.prisma),
    );
  }

  // ------------------------------------------------------------------ 管理操作
  async adminSubscribe(tenantId: string, planId: string, now = new Date()): Promise<BillingSummaryDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.active) throw new NotFoundException('plan_not_found');
    if (plan.id === 'free') throw new BadRequestException('free_not_subscribable');

    const start = now;
    const end = addMonth(now);
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.upsert({
        where: { tenantId },
        create: { tenantId, planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
        update: { planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
      });
      await this.grantPeriod(tx, tenantId, plan, start, end);
    });
    return this.summary(tenantId);
  }

  async adjust(
    tenantId: string,
    amount: number,
    note: string,
    expiresAt: Date | null,
  ): Promise<BillingSummaryDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
      await this.lockCredit(tx, tenantId);

      if (amount > 0) {
        await tx.creditLot.create({
          data: { tenantId, source: 'adjust', granted: amount, remaining: amount, expiresAt, note },
        });
        await tx.creditTx.create({
          data: { tenantId, type: 'adjust', amount, source: 'adjust', note },
        });
        await tx.tenantCredit.update({
          where: { tenantId },
          data: { balance: { increment: amount } },
        });
        return;
      }

      const target = -amount;
      const credit = await tx.tenantCredit.findUnique({ where: { tenantId } });
      if ((credit?.balance ?? 0) - (credit?.reserved ?? 0) < target) {
        throw new BadRequestException('insufficient_balance');
      }
      const lots = await tx.creditLot.findMany({
        where: { tenantId, remaining: { gt: 0 } },
      });
      const { allocations, deducted } = allocate(lots, target);
      if (deducted < target) throw new BadRequestException('insufficient_balance');
      for (const a of allocations) {
        await tx.creditLot.update({
          where: { id: a.lotId },
          data: { remaining: { decrement: a.amount } },
        });
      }
      await tx.creditTx.create({
        data: { tenantId, type: 'adjust', amount: -deducted, source: 'adjust', note },
      });
      await tx.tenantCredit.update({
        where: { tenantId },
        data: { balance: { decrement: deducted } },
      });
    });
    return this.summary(tenantId);
  }

  // ------------------------------------------------------------------ 补偿
  /** 结算超过 olderThan 仍 pending 的用量；单条失败不阻断其余。 */
  async settleStalePending(olderThan: Date): Promise<void> {
    const rows = await this.prisma.usageRecord.findMany({
      where: { status: 'pending', createdAt: { lt: olderThan } },
      select: { runId: true },
      take: 100,
    });
    for (const row of rows) {
      try {
        await this.settle(row.runId);
      } catch (err) {
        console.error(`[billing] 补偿结算失败 run=${row.runId}: ${(err as Error).message}`);
      }
    }
  }

  /** 扫描所有租户的过期批次并清零。 */
  async sweepExpired(now = new Date()): Promise<void> {
    const tenants = await this.prisma.creditLot.findMany({
      where: { expiresAt: { lte: now }, remaining: { gt: 0 } },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    for (const { tenantId } of tenants) {
      await this.prisma.$transaction(async (tx) => {
        await this.lockCredit(tx, tenantId);
        await this.expireDueLots(tx, tenantId, now);
      });
    }
  }

  /** 清理超过 TTL 的预占：有 pending 用量先结算，否则释放；run 仍在跑则保留。 */
  async sweepOrphanHolds(now = new Date()): Promise<void> {
    const holds = await this.prisma.creditHold.findMany({
      where: { expiresAt: { lte: now } },
    });
    for (const hold of holds) {
      const usage = await this.prisma.usageRecord.findUnique({ where: { runId: hold.runId } });
      if (usage?.status === 'pending') {
        try {
          await this.settle(hold.runId);
        } catch (err) {
          console.error(`[billing] 孤儿预占结算失败 run=${hold.runId}: ${(err as Error).message}`);
        }
        continue;
      }
      const run = await this.prisma.run.findUnique({
        where: { id: hold.runId },
        select: { status: true },
      });
      if (!run || run.status !== 'running') await this.releaseHold(hold.runId);
    }
  }

  // ------------------------------------------------------------------ 内部工具
  private async lockCredit(tx: Db, tenantId: string): Promise<void> {
    await tx.$queryRaw`SELECT "tenantId" FROM "TenantCredit" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
  }

  private async expireDueLots(tx: Db, tenantId: string, now: Date): Promise<void> {
    const lots = await tx.creditLot.findMany({
      where: { tenantId, remaining: { gt: 0 }, expiresAt: { lte: now } },
    });
    if (lots.length === 0) return;
    let expired = 0;
    for (const lot of lots) {
      await tx.creditLot.update({ where: { id: lot.id }, data: { remaining: 0 } });
      await tx.creditTx.create({
        data: { tenantId, type: 'expire', amount: -lot.remaining, source: lot.source },
      });
      expired += lot.remaining;
    }
    await tx.tenantCredit.update({
      where: { tenantId },
      data: { balance: { decrement: expired } },
    });
  }

  private async loadPrices(
    client: Db | PrismaService,
  ): Promise<Record<string, { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number }>> {
    const rows = await client.modelPrice.findMany();
    return Object.fromEntries(
      rows.map((r) => [
        r.model,
        {
          inputMilliCreditsPer1k: r.inputMilliCreditsPer1k,
          outputMilliCreditsPer1k: r.outputMilliCreditsPer1k,
        },
      ]),
    );
  }
}
```

- [ ] **Step 3.5: 创建 `billing.rate-limit.ts`（本服务依赖其类型与注入令牌）**

直接采用 Task 7 Step 2 的**完整文件内容**（`RateLimitResult`、`RateLimiter`、`RATE_LIMITER`、`MemoryRateLimiter`、`RedisRateLimiter`、`createRateLimiter`），原样创建 `apps/bff/src/billing/billing.rate-limit.ts`，不要精简或改名。Task 7 届时只需补充其测试与控制器。

- [ ] **Step 4: 运行测试**

```bash
pnpm --filter @ai-office/bff exec vitest run src/billing
pnpm --filter @ai-office/bff typecheck
```

Expected: 全部 PASS。若 fake Prisma 缺少方法导致报错，按服务实际调用补齐 fake（不要改服务去迁就测试）。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/billing/billing.errors.ts apps/bff/src/billing/billing.rate-limit.ts apps/bff/src/billing/billing.service.ts apps/bff/src/billing/billing.service.test.ts
git commit -m "feat(billing): 实现积分预占、结算与补偿核心服务"
```

---

## Task 7: 限流器、BFF 查询/管理接口与模块装配

**Files:**
- Create: `apps/bff/src/billing/billing.rate-limit.ts`
- Create: `apps/bff/src/billing/billing.rate-limit.test.ts`
- Create: `apps/bff/src/billing/billing.controller.ts`
- Create: `apps/bff/src/billing/billing-admin.controller.ts`
- Create: `apps/bff/src/billing/billing.module.ts`

- [ ] **Step 1: 先写限流失败测试 `billing.rate-limit.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { MemoryRateLimiter } from './billing.rate-limit';

describe('MemoryRateLimiter', () => {
  it('窗口内超限拒绝，并给出重试秒数', async () => {
    const limiter = new MemoryRateLimiter();
    expect((await limiter.hit('t1', 2)).allowed).toBe(true);
    expect((await limiter.hit('t1', 2)).allowed).toBe(true);
    const third = await limiter.hit('t1', 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it('不同租户互不影响', async () => {
    const limiter = new MemoryRateLimiter();
    await limiter.hit('a', 1);
    expect((await limiter.hit('b', 1)).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: 新建 `billing.rate-limit.ts`**

```ts
import { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds?: number): Promise<RateLimitResult>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/** 单实例固定窗口；多实例部署必须配 Redis。 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
    const now = Date.now();
    const window = Math.floor(now / (windowSeconds * 1000));
    const bucketKey = `${key}:${window}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: (window + 1) * windowSeconds * 1000 };
      this.buckets.set(bucketKey, bucket);
      if (this.buckets.size > 10_000) this.prune(now);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/** Redis 固定窗口：INCR + 首次过期；故障时放行（账本与预占仍是硬约束）。 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey = `rl:${key}:${window}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) await this.redis.expire(redisKey, windowSeconds * 2);
      return { allowed: count <= limit, retryAfter: windowSeconds };
    } catch {
      return { allowed: true, retryAfter: 0 };
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

export function createRateLimiter(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const url = env.REDIS_URL;
  if (!url) return new MemoryRateLimiter();
  return new RedisRateLimiter(new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 }));
}
```

- [ ] **Step 3: 新建 `billing.controller.ts`**

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { BillingSummaryDto, PlanDto, CreditLedgerPageDto, UsageAggregateDto } from '@ai-office/shared';
import { BillingService } from './billing.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

/** 用户侧计费查询：套餐目录、余额、流水、按日/模型用量。 */
@Controller('api/billing')
@UseGuards(JwtGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  plans(): Promise<PlanDto[]> {
    return this.billing.listPlans();
  }

  @Get('summary')
  summary(@CurrentUser() user: JwtPayload): Promise<BillingSummaryDto> {
    return this.billing.summary(user.tenantId);
  }

  @Get('ledger')
  ledger(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<CreditLedgerPageDto> {
    return this.billing.ledger(user.tenantId, Number(limit ?? 20), cursor);
  }

  @Get('usage')
  usage(
    @CurrentUser() user: JwtPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
  ): Promise<UsageAggregateDto[]> {
    const now = new Date();
    const fromDate = parseDate(from) ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const toDate = parseDate(to) ?? now;
    return this.billing.usage(user.tenantId, fromDate, toDate, groupBy === 'model' ? 'model' : 'day');
  }
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
```

- [ ] **Step 4: 新建 `billing-admin.controller.ts`**

```ts
import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { BillingSummaryDto } from '@ai-office/shared';
import { BillingService } from './billing.service';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

/** 管理操作：开通/续期套餐、调整积分；仅作用于调用者所在租户。 */
@Controller('api/billing/admin')
@UseGuards(JwtGuard, AdminGuard)
export class BillingAdminController {
  constructor(private readonly billing: BillingService) {}

  @Post('subscribe')
  subscribe(
    @CurrentUser() user: JwtPayload,
    @Body() body: { planId?: unknown },
  ): Promise<BillingSummaryDto> {
    if (typeof body?.planId !== 'string' || body.planId === '') {
      throw new BadRequestException('invalid_plan');
    }
    return this.billing.adminSubscribe(user.tenantId, body.planId);
  }

  @Post('credits')
  credits(
    @CurrentUser() user: JwtPayload,
    @Body() body: { amount?: unknown; note?: unknown; expiresAt?: unknown },
  ): Promise<BillingSummaryDto> {
    if (typeof body?.amount !== 'number' || !Number.isInteger(body.amount) || body.amount === 0) {
      throw new BadRequestException('invalid_amount');
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'string') throw new BadRequestException('invalid_expires_at');
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('invalid_expires_at');
    }
    const note = typeof body.note === 'string' ? body.note : '';
    return this.billing.adjust(user.tenantId, body.amount, note, expiresAt);
  }
}
```

- [ ] **Step 5: 新建 `billing.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingAdminController } from './billing-admin.controller';
import { BillingService } from './billing.service';
import { RATE_LIMITER, createRateLimiter } from './billing.rate-limit';

@Module({
  controllers: [BillingController, BillingAdminController],
  providers: [
    BillingService,
    { provide: RATE_LIMITER, useFactory: () => createRateLimiter() },
  ],
  exports: [BillingService],
})
export class BillingModule {}
```

- [ ] **Step 6: 运行测试与类型检查**

```bash
pnpm --filter @ai-office/bff exec vitest run src/billing
pnpm --filter @ai-office/bff typecheck
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/bff/src/billing
git commit -m "feat(billing): 新增限流、计费查询与管理接口"
```

---

## Task 8: tasks 接入（限流、预占、usage、结算、断连排空）

**Files:**
- Modify: `apps/bff/src/tasks/tasks.service.ts`
- Modify: `apps/bff/src/tasks/tasks.controller.ts`
- Modify: `apps/bff/src/tasks/tasks.controller.test.ts`

- [ ] **Step 1: `tasks.service.ts` 拆出归属校验，`prepare` 接受预生成 runId**

```ts
  /** 只为归属校验：让控制器能在计费预占之前先做 404 判断。 */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);
  }

  /** 建 task/run、落用户消息，并回传喂给模型的完整历史。runId 由控制器预生成（计费预占键）。 */
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
    runId: string,
  ): Promise<{ taskId: string; runId: string; tenantId: string; userId: string; messages: ChatMessage[] }> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);

    const prior = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    const task = await this.prisma.task.create({
      data: { sessionId, goal, status: 'running' },
    });
    const run = await this.prisma.run.create({
      data: { id: runId, taskId: task.id, status: 'running' },
    });
    await this.prisma.message.create({
      data: { sessionId, role: 'user', content: goal, seq: prior.length },
    });

    const messages: ChatMessage[] = [
      ...prior.map((m) => ({ role: m.role as ChatMessage['role'], content: m.content })),
      { role: 'user', content: goal },
    ];
    return { taskId: task.id, runId: run.id, tenantId, userId, messages };
  }
```

- [ ] **Step 2: 先改测试（`tasks.controller.test.ts`）**

2.1 顶部增加导入：

```ts
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';
```

2.2 增加 fake billing 与状态：

```ts
const billingCalls: unknown[][] = [];
let beginRunError: unknown = null;
const fakeBilling = {
  beginRun: async (runId: string, tenantId: string) => {
    billingCalls.push(['begin', runId, tenantId]);
    if (beginRunError) throw beginRunError;
    return {
      maxCredits: 50,
      allowedModels: ['mock'],
      prices: { mock: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 } },
    };
  },
  recordUsage: async (...args: unknown[]) => {
    billingCalls.push(['record', ...args]);
  },
  settle: async (runId: string) => {
    billingCalls.push(['settle', runId]);
  },
  releaseHold: async (runId: string) => {
    billingCalls.push(['release', runId]);
  },
} as unknown as BillingService;
```

2.3 测试模块 providers 加 `{ provide: BillingService, useValue: fakeBilling }`。

2.4 fake Prisma 的 `run.create` 改为保留传入 id：

```ts
run: {
  create: async ({ data }: { data: unknown }) => ({ id: (data as { id?: string }).id ?? 'run1', ...(data as object) }),
  ...
}
```

2.5 上游 SSE 的 usage 事件改为新结构：

```ts
res.write(encodeSse({ event: 'usage', data: { input: 1, output: 1, models: [{ model: 'mock', input: 1, output: 1 }] } }));
```

2.6 `beforeEach` 里重置：`billingCalls.length = 0; beginRunError = null;`。

2.7 新增用例：

```ts
it('收到 usage 后记录并结算预占', async () => {
  const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ goal: '写个总结' }),
  });
  await res.text();
  expect(billingCalls[0]?.[0]).toBe('begin');
  expect(billingCalls.some((c) => c[0] === 'record')).toBe(true);
  expect(billingCalls.some((c) => c[0] === 'settle')).toBe(true);
});

it('上游无 usage 时只释放预占', async () => {
  upstreamMode = 'nousage';
  // upstream 分支：只发 step + done
  ...
  expect(billingCalls.some((c) => c[0] === 'settle')).toBe(false);
  expect(billingCalls.some((c) => c[0] === 'release')).toBe(true);
});

it('可用积分不足返回 402', async () => {
  beginRunError = new InsufficientCreditsError();
  const res = await fetch(...);
  expect(res.status).toBe(402);
  expect(await res.json()).toEqual({ error: 'insufficient_credits' });
});

it('套餐过期返回 402，限流返回 429', async () => {
  beginRunError = new PlanExpiredError();
  const r1 = await fetch(...);
  expect(r1.status).toBe(402);
  expect(await r1.json()).toEqual({ error: 'plan_expired' });

  beginRunError = new RateLimitedError(30);
  const r2 = await fetch(...);
  expect(r2.status).toBe(429);
  expect(r2.headers.get('retry-after')).toBe('30');
});
```

2.8 上游增加 `nousage` 与 `slow` 模式：

```ts
let upstreamMode: 'ok' | 'error' | 'nousage' | 'slow' = 'ok';
```

`end` 回调中：

```ts
if (upstreamMode === 'nousage') {
  res.write(encodeSse({ event: 'done', data: { runId: 'run1' } }));
  res.end();
  return;
}
if (upstreamMode === 'slow') {
  res.write(encodeSse({ step 0 }));
  setTimeout(() => {
    res.write(encodeSse({ event: 'usage', data: { input: 1, output: 1, models: [{ model: 'mock', input: 1, output: 1 }] } }));
    res.write(encodeSse({ event: 'done', data: { runId: 'run1' } }));
    res.end();
  }, 100);
  return;
}
```

2.9 断连排空用例：

```ts
it('客户端断开后仍继续排空上游并结算', async () => {
  upstreamMode = 'slow';
  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/api/sessions/${session.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ goal: '长任务' }),
    signal: ac.signal,
  });
  const reader = res.body!.getReader();
  await reader.read(); // 至少收到首帧后再断开
  ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  expect(billingCalls.some((c) => c[0] === 'settle')).toBe(true);
});
```

Run: `pnpm --filter @ai-office/bff exec vitest run src/tasks/tasks.controller.test.ts`
Expected: FAIL（控制器尚未接入 billing）。

- [ ] **Step 3: 改写 `tasks.controller.ts` 主流程**

顶部导入：

```ts
import { randomUUID } from 'node:crypto';
import type { ArtifactRef, RunBilling } from '@ai-office/shared';
import { BillingService } from '../billing/billing.service';
import { InsufficientCreditsError, PlanExpiredError, RateLimitedError } from '../billing/billing.errors';
```

构造函数：

```ts
  constructor(
    private readonly tasks: TasksService,
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
  ) {}
```

`run` 方法改为（完整替换原方法体）：

```ts
  @Post(':id/tasks')
  async run(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: CreateTaskRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
    const goal = body?.goal;

    if (typeof goal !== 'string' || goal.length === 0) {
      reply.status(400).send({ error: 'invalid_goal' });
      return;
    }

    // 归属校验放在预占之前：404 不应留下 hold。
    await this.tasks.assertOwned(sessionId, user.tenantId, user.sub);

    // 预占额度并做限流；失败在 hijack 之前返回，Nest 可正常写响应。
    const runId = randomUUID();
    let billing: RunBilling;
    try {
      billing = await this.billing.beginRun(runId, user.tenantId);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        reply
          .header('retry-after', String(err.retryAfter))
          .status(429)
          .send({ error: 'rate_limited', retryAfter: err.retryAfter });
        return;
      }
      if (err instanceof InsufficientCreditsError) {
        reply.status(402).send({ error: 'insufficient_credits' });
        return;
      }
      if (err instanceof PlanExpiredError) {
        reply.status(402).send({ error: 'plan_expired' });
        return;
      }
      throw err;
    }

    let prepared: Awaited<ReturnType<TasksService['prepare']>>;
    try {
      prepared = await this.tasks.prepare(sessionId, user.tenantId, user.sub, goal, runId);
    } catch (err) {
      // 建 task/run 失败：归还预占（best-effort），再交给 Nest 处理原异常。
      await this.billing.releaseHold(runId).catch(() => undefined);
      throw err;
    }
    const { taskId, tenantId, userId, messages } = prepared;

    reply.hijack();

    // 客户端断开后停止写回复，但**继续排空上游**：否则 usage 与产物会漏落库。
    let clientGone = false;
    const onClientGone = (): void => {
      clientGone = true;
    };
    reply.raw.on('error', onClientGone);
    reply.raw.on('close', onClientGone);

    let upstream: Response;
    try {
      upstream = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(runtimeToken ? { 'x-agent-runtime-token': runtimeToken } : {}),
        },
        body: JSON.stringify({ runId, sessionId, tenantId, userId, goal, messages, billing }),
      });
    } catch {
      await this.billing.releaseHold(runId).catch(() => undefined);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      writeHead(reply, 502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
      return;
    }

    if (!upstream.ok || !upstream.body) {
      await this.billing.releaseHold(runId).catch(() => undefined);
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      writeHead(reply, upstream.status, { 'content-type': contentType });
      reply.raw.end(await upstream.text());
      return;
    }

    writeHead(reply, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const parse = createSseParser();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const thinkTexts: string[] = [];
    let status: 'done' | 'failed' = 'done';
    let latestUsage: UsageEvent | null = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!clientGone) reply.raw.write(chunk);
        for (const m of parse(chunk)) {
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            if (ev.type === 'think') thinkTexts.push(String(ev.payload.text ?? ''));
            await this.tasks.recordStep(runId, ev);
            if (ev.type === 'artifact') {
              await this.safeRecordArtifact(runId, sessionId, tenantId, ev.payload);
            }
          } else if (m.event === 'usage') {
            const usage = parseUsageEvent(m.data);
            if (usage) latestUsage = usage;
          } else if (m.event === 'error') {
            status = 'failed';
          }
        }
      }
    } catch (err) {
      status = 'failed';
      this.logger.error(`run ${runId} 处理失败，标记为 failed: ${(err as Error).message}`);
    } finally {
      // 结算优先于 finish：即使 finish 失败，用量也已落账。
      // 结算抛错时保留 hold 与 pending，由补偿任务重试。
      if (latestUsage) {
        try {
          await this.billing.recordUsage(runId, { tenantId, userId, sessionId }, latestUsage);
          await this.billing.settle(runId);
        } catch (err) {
          this.logger.error(`run ${runId} 计费结算失败（保留 pending 待补偿）: ${(err as Error).message}`);
        }
      } else {
        try {
          await this.billing.releaseHold(runId);
        } catch (err) {
          this.logger.error(`run ${runId} 释放预占失败: ${(err as Error).message}`);
        }
      }
      await this.safeFinish(runId, taskId, status, thinkTexts.join('\n'), sessionId);
      try {
        reply.raw.end();
      } catch {
        // 客户端已断开时 end() 可能抛错，忽略。
      }
    }
  }
```

同时导入 `UsageEvent` 与 `parseUsageEvent`：

```ts
import type { AgentEvent, ArtifactRef, RunBilling, UsageEvent } from '@ai-office/shared';
import { parseUsageEvent } from '../billing/usage';
```

- [ ] **Step 4: 运行测试**

```bash
pnpm --filter @ai-office/bff exec vitest run src/tasks/tasks.controller.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: PASS。重点确认：402/429 在 hijack 之前返回；无 usage 只 release；断连后仍 settle。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/tasks/tasks.service.ts apps/bff/src/tasks/tasks.controller.ts apps/bff/src/tasks/tasks.controller.test.ts
git commit -m "feat(billing): 运行前预占、运行后结算并支持断连排空"
```

---

## Task 9: 注册懒开通、补偿任务与 AppModule 装配

**Files:**
- Modify: `apps/bff/src/auth/auth.service.ts`
- Create: `apps/bff/src/billing/billing.sweeper.ts`
- Create: `apps/bff/src/billing/billing.sweeper.test.ts`
- Modify: `apps/bff/src/app.module.ts`
- Modify: `apps/bff/src/billing/billing.module.ts`

- [ ] **Step 1: `auth.service.ts` 注册后 best-effort 开通 free 订阅**

```ts
import { Optional } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly billing?: BillingService,
  ) {}
```

`register` 在 `return this.issue(...)` 之前加：

```ts
    // 预建 free 订阅；失败不阻断注册——首次访问计费入口时会懒建兜底。
    try {
      await this.billing?.ensureSubscription(user.tenantId);
    } catch (err) {
      console.warn(`[billing] 注册开通免费套餐失败 tenant=${user.tenantId}: ${(err as Error).message}`);
    }
```

- [ ] **Step 2: 先写 sweeper 测试 `billing.sweeper.test.ts`**

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BillingSweeper } from './billing.sweeper';
import type { BillingService } from './billing.service';

describe('BillingSweeper.tick', () => {
  it('每分钟结算陈旧 pending，并扫描孤儿预占；异常不外抛', async () => {
    const calls: string[] = [];
    const billing = {
      settleStalePending: async () => { calls.push('stale'); },
      sweepOrphanHolds: async () => { calls.push('holds'); },
      sweepExpired: async () => { calls.push('expired'); },
    } as unknown as BillingService;
    const sweeper = new BillingSweeper(billing);
    await sweeper.tick();
    expect(calls).toContain('stale');
    expect(calls).toContain('holds');
  });

  it('单个扫描失败不向外抛', async () => {
    const billing = {
      settleStalePending: async () => { throw new Error('db down'); },
      sweepOrphanHolds: async () => undefined,
      sweepExpired: async () => undefined,
    } as unknown as BillingService;
    await expect(new BillingSweeper(billing).tick()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 新建 `billing.sweeper.ts`**

```ts
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BillingService } from './billing.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 计费补偿：每分钟结算陈旧 pending、清理孤儿预占；每天扫描过期批次。 */
@Injectable()
export class BillingSweeper implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private lastExpireScan = 0;

  constructor(private readonly billing: BillingService) {}

  onModuleInit(): void {
    const interval = Number(process.env.BILLING_SWEEP_MS ?? 60000);
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出（测试/短生命周期命令）。
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    try {
      await this.billing.settleStalePending(new Date(now.getTime() - 60_000));
    } catch (err) {
      console.error(`[billing] 补偿结算扫描失败: ${(err as Error).message}`);
    }
    try {
      await this.billing.sweepOrphanHolds(now);
    } catch (err) {
      console.error(`[billing] 孤儿预占扫描失败: ${(err as Error).message}`);
    }
    if (now.getTime() - this.lastExpireScan >= DAY_MS) {
      this.lastExpireScan = now.getTime();
      try {
        await this.billing.sweepExpired(now);
      } catch (err) {
        console.error(`[billing] 过期批次扫描失败: ${(err as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step 4: `billing.module.ts` 注册 sweeper 并导出**

```ts
import { BillingSweeper } from './billing.sweeper';

@Module({
  controllers: [BillingController, BillingAdminController],
  providers: [
    BillingService,
    BillingSweeper,
    { provide: RATE_LIMITER, useFactory: () => createRateLimiter() },
  ],
  exports: [BillingService],
})
export class BillingModule {}
```

- [ ] **Step 5: `app.module.ts` 导入 BillingModule**

```ts
import { BillingModule } from './billing/billing.module';

@Module({
  imports: [PrismaModule, BillingModule, KbModule, ConnectorModule],
  ...
})
```

`TasksController`/`TasksService` 保持原位；`BillingService` 由 `BillingModule` 导出后可注入。

- [ ] **Step 6: 运行 BFF 全量测试与类型检查**

```bash
pnpm --filter @ai-office/bff test
pnpm --filter @ai-office/bff typecheck
```

Expected: PASS。若 auth 测试因构造签名报警，确认使用了 `@Optional()`；直接 `new AuthService(prisma)` 的测试无需修改。

- [ ] **Step 7: 提交**

```bash
git add apps/bff/src/auth/auth.service.ts apps/bff/src/billing/billing.sweeper.ts apps/bff/src/billing/billing.sweeper.test.ts apps/bff/src/billing/billing.module.ts apps/bff/src/app.module.ts
git commit -m "feat(billing): 注册即开通免费套餐并加入补偿扫描"
```

---

## Task 10: Web 套餐与用量页

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/render-step.ts`
- Create: `apps/web/src/lib/render-step.test.ts`（若已存在则追加）
- Create: `apps/web/src/app/billing/page.tsx`
- Modify: `apps/web/src/components/app-shell.tsx`
- Modify: `apps/web/src/components/icons.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: `api.ts` 追加计费客户端**

```ts
import type {
  ArtifactDto, AuthResponse, BillingSummaryDto, ConnectorDto, CreditLedgerPageDto,
  KbDocDto, PlanDto, SessionSummary, UsageAggregateDto,
} from '@ai-office/shared';

export async function listPlans(): Promise<PlanDto[]> {
  const res = await authFetch('/api/billing/plans');
  if (!res.ok) throw new Error(`plans_failed_${res.status}`);
  return (await res.json()) as PlanDto[];
}

export async function getBillingSummary(): Promise<BillingSummaryDto> {
  const res = await authFetch('/api/billing/summary');
  if (!res.ok) throw new Error(`billing_summary_failed_${res.status}`);
  return (await res.json()) as BillingSummaryDto;
}

export async function listCreditLedger(limit = 20, cursor?: string): Promise<CreditLedgerPageDto> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set('cursor', cursor);
  const res = await authFetch(`/api/billing/ledger?${qs.toString()}`);
  if (!res.ok) throw new Error(`billing_ledger_failed_${res.status}`);
  return (await res.json()) as CreditLedgerPageDto;
}

export async function getUsage(
  groupBy: 'day' | 'model',
  from?: string,
  to?: string,
): Promise<UsageAggregateDto[]> {
  const qs = new URLSearchParams({ groupBy });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const res = await authFetch(`/api/billing/usage?${qs.toString()}`);
  if (!res.ok) throw new Error(`billing_usage_failed_${res.status}`);
  return (await res.json()) as UsageAggregateDto[];
}
```

- [ ] **Step 2: `api.test.ts` 增加失败测试（先失败）**

```ts
import { getBillingSummary, getUsage } from './api';

describe('billing api', () => {
  it('summary 走 /api/billing/summary', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ balance: 10, reserved: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await getBillingSummary();
    expect(out.balance).toBe(10);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/billing/summary');
  });

  it('usage 透传 groupBy', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getUsage('model');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('groupBy=model');
  });
});
```

Run: `pnpm --filter @ai-office/web test` → FAIL。

- [ ] **Step 3: `render-step.ts` 增加 notice 分支**

```ts
    case 'notice':
      return `提示：${String(ev.payload.message ?? '')}`;
```

在 `render-step.test.ts` 增加：

```ts
it('notice 渲染为提示文本', () => {
  expect(
    renderStep({
      runId: 'r1',
      seq: 1,
      type: 'notice',
      payload: { code: 'budget_exceeded', message: '预算已用完' },
      ts: 0,
    }),
  ).toBe('提示：预算已用完');
});
```

（若测试文件不存在，按现有测试风格新建，`import { renderStep } from './render-step';`。）

- [ ] **Step 4: `icons.tsx` 增加钱包图标**

```tsx
export function IconWallet(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19v14H5.5A2.5 2.5 0 0 1 3 16.5v-9z" />
      <path d="M3 8h16" />
      <path d="M16 12.5h2.5v3H16a1.5 1.5 0 0 1 0-3z" />
    </Svg>
  );
}
```

- [ ] **Step 5: `app-shell.tsx` 增加「套餐与用量」导航**

```ts
import { IconBook, IconChat, IconLogout, IconPlug, IconPlus, IconSpark, IconWallet } from './icons';

type ActiveNav = 'workbench' | 'kb' | 'connectors' | 'billing';

const NAV = [
  { key: 'workbench', href: '/', label: '工作台', icon: IconChat },
  { key: 'kb', href: '/kb', label: '知识库', icon: IconBook },
  { key: 'connectors', href: '/connectors', label: '连接器', icon: IconPlug },
  { key: 'billing', href: '/billing', label: '套餐与用量', icon: IconWallet },
] satisfies { key: ActiveNav; href: string; label: string; icon: typeof IconChat }[];
```

- [ ] **Step 6: 新建 `/billing` 页**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  BillingSummaryDto,
  CreditLedgerItemDto,
  PlanDto,
  UsageAggregateDto,
} from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import {
  getBillingSummary,
  getToken,
  getUsage,
  isUnauthorized,
  listCreditLedger,
  listPlans,
} from '../../lib/api';
import { errorText } from '../../lib/errors';

const TYPE_LABEL: Record<string, string> = {
  grant: '发放',
  consume: '消耗',
  expire: '过期',
  adjust: '调整',
  refund: '退款',
};

function money(cents: number): string {
  return cents === 0 ? '免费' : `¥${(cents / 100).toFixed(0)}/月`;
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export default function BillingPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<BillingSummaryDto | null>(null);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerItemDto[]>([]);
  const [usage, setUsage] = useState<UsageAggregateDto[]>([]);
  const [groupBy, setGroupBy] = useState<'day' | 'model'>('day');
  const [error, setError] = useState('');

  const load = useCallback(
    async (group: 'day' | 'model') => {
      try {
        const [s, p, l, u] = await Promise.all([
          getBillingSummary(),
          listPlans(),
          listCreditLedger(30),
          getUsage(group),
        ]);
        setSummary(s);
        setPlans(p);
        setLedger(l.items);
        setUsage(u);
      } catch (err) {
        if (isUnauthorized(err)) {
          router.push('/login');
          return;
        }
        setError(errorText(err));
      }
    },
    [router],
  );

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void load(groupBy);
  }, [load, router, groupBy]);

  const quota = summary
    ? summary.plan.monthlyBaseCredits + summary.plan.monthlyBonusCredits
    : 0;
  const percent = quota > 0 && summary ? Math.min(100, Math.round((summary.balance / quota) * 100)) : 0;

  return (
    <AppShell active="billing">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">套餐与用量</h1>
              <p className="page-sub">积分按模型 token 折算，每月到期作废、不结转。</p>
            </div>
            {summary && (
              <div className="page-head-actions">
                <span className={`status ${summary.subscription.status === 'active' ? 'status-ready' : 'status-failed'}`}>
                  {summary.subscription.status === 'active' ? '生效中' : '已过期'}
                </span>
              </div>
            )}
          </header>

          {error && (
            <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          {summary && (
            <section className="billing-grid">
              <div className="billing-card billing-card-main">
                <div className="billing-label">当前套餐</div>
                <div className="billing-plan">{summary.plan.name}</div>
                <div className="billing-sub">
                  周期 {stamp(summary.subscription.periodStart)} — {stamp(summary.subscription.periodEnd)}
                </div>
                <div className="billing-bar">
                  <div className="billing-bar-fill" style={{ width: `${percent}%` }} />
                </div>
                <div className="billing-sub">
                  可用 {summary.balance} 积分{summary.reserved > 0 ? ` · 已预占 ${summary.reserved}` : ''}
                </div>
              </div>
              <div className="billing-card">
                <div className="billing-label">本周期额度</div>
                <div className="billing-stat">{quota}</div>
                <div className="billing-sub">
                  基础 {summary.plan.monthlyBaseCredits} + 赠送 {summary.plan.monthlyBonusCredits}
                </div>
              </div>
              <div className="billing-card">
                <div className="billing-label">最近到期</div>
                <div className="billing-stat">{summary.nextExpiry ? summary.nextExpiry.amount : 0}</div>
                <div className="billing-sub">
                  {summary.nextExpiry ? stamp(summary.nextExpiry.expiresAt) : '暂无积分'}
                </div>
              </div>
            </section>
          )}

          <section className="billing-section">
            <h2 className="billing-heading">套餐目录</h2>
            <div className="billing-plans">
              {plans.map((p) => (
                <div key={p.id} className={`billing-card${summary?.plan.id === p.id ? ' current' : ''}`}>
                  <div className="billing-plan">{p.name}</div>
                  <div className="billing-price">{money(p.priceCents)}</div>
                  <ul className="billing-list">
                    <li>每月 {p.monthlyBaseCredits + p.monthlyBonusCredits} 积分</li>
                    <li>单次最多 {p.maxCreditsPerRun} 积分</li>
                    <li>每分钟 {p.rpm} 次运行</li>
                    <li>模型：{p.allowedModels.join('、')}</li>
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section className="billing-section">
            <div className="billing-section-head">
              <h2 className="billing-heading">用量</h2>
              <div className="billing-tabs" role="tablist">
                <button
                  type="button"
                  className={`billing-tab${groupBy === 'day' ? ' active' : ''}`}
                  onClick={() => setGroupBy('day')}
                >
                  按日
                </button>
                <button
                  type="button"
                  className={`billing-tab${groupBy === 'model' ? ' active' : ''}`}
                  onClick={() => setGroupBy('model')}
                >
                  按模型
                </button>
              </div>
            </div>
            {usage.length === 0 ? (
              <div className="billing-empty">暂无用量记录</div>
            ) : (
              <table className="billing-table">
                <thead>
                  <tr>
                    <th>{groupBy === 'day' ? '日期' : '模型'}</th>
                    <th>运行次数</th>
                    <th>输入 token</th>
                    <th>输出 token</th>
                    <th>积分</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.key}>
                      <td>{u.key}</td>
                      <td>{u.runs}</td>
                      <td>{u.inputTokens}</td>
                      <td>{u.outputTokens}</td>
                      <td>{u.credits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="billing-section">
            <h2 className="billing-heading">积分流水</h2>
            {ledger.length === 0 ? (
              <div className="billing-empty">暂无流水</div>
            ) : (
              <table className="billing-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>来源</th>
                    <th>数量</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((t) => (
                    <tr key={t.id}>
                      <td>{stamp(t.createdAt)}</td>
                      <td>{TYPE_LABEL[t.type] ?? t.type}</td>
                      <td>{t.source ?? '—'}</td>
                      <td className={t.amount < 0 ? 'billing-negative' : 'billing-positive'}>
                        {t.amount > 0 ? `+${t.amount}` : t.amount}
                      </td>
                      <td>{t.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 7: `globals.css` 末尾加样式**

```css
/* ================================ 计费页 ================================ */

.billing-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 12px;
  margin-bottom: 24px;
}

.billing-card {
  padding: 18px 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-1);
}

.billing-card-main {
  background: linear-gradient(140deg, #ffffff 0%, var(--mint-soft) 100%);
  border-color: #cfeee2;
}

.billing-card.current {
  border-color: var(--mint);
  box-shadow: 0 0 0 1px var(--mint) inset;
}

.billing-label {
  color: var(--ink-3);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.billing-plan {
  margin-top: 4px;
  font-size: 20px;
  font-weight: 650;
}

.billing-price {
  margin-top: 2px;
  color: var(--mint-ink);
  font-weight: 600;
}

.billing-stat {
  margin-top: 4px;
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.billing-sub {
  margin-top: 6px;
  color: var(--ink-2);
  font-size: 12px;
}

.billing-bar {
  height: 8px;
  margin-top: 12px;
  overflow: hidden;
  background: rgba(0, 201, 141, 0.14);
  border-radius: 999px;
}

.billing-bar-fill {
  height: 100%;
  background: var(--mint);
  border-radius: 999px;
  transition: width 0.3s ease;
}

.billing-section {
  margin-bottom: 24px;
}

.billing-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.billing-heading {
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 650;
}

.billing-plans {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.billing-list {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--ink-2);
  font-size: 12px;
}

.billing-list li {
  margin-bottom: 2px;
}

.billing-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: var(--bg-deep);
  border-radius: var(--radius-sm);
}

.billing-tab {
  padding: 4px 12px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--ink-2);
  cursor: pointer;
}

.billing-tab.active {
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow-1);
}

.billing-table {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  border-collapse: separate;
  border-spacing: 0;
  overflow: hidden;
  font-size: 13px;
}

.billing-table th,
.billing-table td {
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--line);
}

.billing-table th {
  color: var(--ink-3);
  font-size: 12px;
  font-weight: 500;
  background: var(--surface-2);
}

.billing-table tr:last-child td {
  border-bottom: 0;
}

.billing-positive {
  color: var(--mint-ink);
  font-variant-numeric: tabular-nums;
}

.billing-negative {
  color: var(--danger);
  font-variant-numeric: tabular-nums;
}

.billing-empty {
  padding: 28px;
  color: var(--ink-3);
  text-align: center;
  background: var(--surface);
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
}

@media (max-width: 900px) {
  .billing-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 8: 运行 web 测试与构建**

```bash
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web build
```

Expected: PASS。然后启动前端，在浏览器打开 `/billing` 检查：套餐卡片、余额进度条、流水表、按日/按模型切换均可用（数据来自 Task 12 的真实账号）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/lib/render-step.ts apps/web/src/lib/render-step.test.ts apps/web/src/app/billing/page.tsx apps/web/src/components/app-shell.tsx apps/web/src/components/icons.tsx apps/web/src/app/globals.css
git commit -m "feat(web): 新增套餐与用量页及预算超限提示"
```

---

## Task 11: 配置、注释与文档同步

**Files:**
- Modify: `docs/deploy/06-deployment.md`
- Modify: `docs/develop/04-dev-guide.md`
- Modify: `docs/develop/05-dev-plan.md`

- [ ] **Step 1: `docs/deploy/06-deployment.md` 追加 M5a 部署说明**

```md
## M5a 计费与网关

### 依赖

- PostgreSQL（已有）、Redis（限流用，可选但生产必配）。
- `docker compose up -d` 会同时启动 `redis:7.4-alpine`。

### 初始化

```bash
pnpm --filter @ai-office/bff db:push
pnpm --filter @ai-office/bff db:seed:billing
```

`db:seed:billing` 幂等写入 4 个套餐与模型价格；调价改该脚本后重跑即可。

### 关键环境变量

| 变量 | 说明 |
|---|---|
| `REDIS_URL` | 留空退化为进程内限流（仅单实例）；生产必须配置 |
| `MODEL_PROVIDERS` | JSON 数组，声明模型、baseUrl、apiKeyEnv；未配置回退 `MODEL_BASE_URL` + `MODEL_NAME` |
| `BILLING_SWEEP_MS` | 补偿扫描间隔，默认 60000；0 关闭 |

### 运营操作（管理员 JWT）

```bash
# 开通/续期付费套餐
curl -X POST http://localhost:4000/api/billing/admin/subscribe \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"planId":"standard"}'

# 发放/收回积分（负数收回）
curl -X POST http://localhost:4000/api/billing/admin/credits \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"amount":1000,"note":"活动赠送"}'
```

### 失败排查

- `insufficient_balance`：管理员收回积分超过可用余额。
- 运行 402 `insufficient_credits`：可用积分不足 1。
- 运行 429：超过套餐 RPM；响应头 `retry-after` 给出等待秒数。
- 结算失败：`UsageRecord` 保持 `pending`，`CreditHold` 保留，补偿任务每分钟重试。
```

- [ ] **Step 2: `docs/develop/04-dev-guide.md` 追加本地开发步骤**

```md
## 计费模块（M5a）本地开发

1. `pnpm --filter @ai-office/bff db:up`（Postgres + MinIO + Redis）。
2. `pnpm --filter @ai-office/bff db:push && pnpm --filter @ai-office/bff db:seed:billing`。
3. 注册账号后自动获得 free 套餐 500 积分。
4. 无 `DEEPSEEK_API_KEY` 时 runtime 走 mock 模型，仍会产出 usage，可完整验证结算链路。
5. 模拟管理员操作：先把账号提权 `pnpm --filter @ai-office/bff admin:promote -- <email>`，再调 `/api/billing/admin/*`。
```

- [ ] **Step 3: `docs/develop/05-dev-plan.md` 拆分 M5 并回填 M5a**

M5 里程碑行改为：

```md
| **M5 商业化** | 计费与网关（M5a）+ 可观测/队列（M5b）+ 支付与上线（M5c） | M5a ✅ 已交付 | 个人版可对外 |
```

第 5 节改为：

```md
## 5. M5 商业化（拆分）

M5 含计费、可观测、队列、上线等独立子系统，拆为三期：

### 5.1 M5a 计费与网关 ✅ 已交付

- 套餐/订阅 + 月度积分账本（`CreditLot`/`CreditTx`/`TenantCredit`），到期作废、不结转。
- 运行前预占、`usage` 事件结算、断连排空与补偿扫描；余额不足 402、超 RPM 429。
- runtime 多模型路由与可重试 fallback；按积分预算硬停并发 `notice`。
- Web `/billing`：套餐、余额、流水、按日/模型用量。
- 验收：个人用户可注册使用并看到用量；重复结算不重复扣费；超预算自动停止。

### 5.2 M5b 可观测 + 队列（规划）

- 全链路 trace、token/成本指标、看板与告警。
- BullMQ/Redis 任务队列、断点续跑（复用 `step` checkpoint）。

### 5.3 M5c 支付与上线（规划）

- 支付网关、自动续费、发票/退款、加油包。
- CI/CD、备份恢复、反代/TLS、密钥托管、CORS 收敛。
```

- [ ] **Step 4: 提交**

```bash
git add docs/deploy/06-deployment.md docs/develop/04-dev-guide.md docs/develop/05-dev-plan.md
git commit -m "docs(m5a): 补充计费部署、开发与里程碑说明"
```

---

## Task 12: 全量回归与端到端验收

**Files:** 无新增（只验证；发现问题回到对应 Task 修复）

- [ ] **Step 1: 全量测试与构建**

```bash
pnpm test
pnpm build
```

Expected: 所有包测试通过；构建 4/4 成功。记录用例总数，确保不低于改造前的 326 且新增用例全部纳入。

- [ ] **Step 2: 启动基础设施与服务**

```bash
pnpm --filter @ai-office/bff db:up
pnpm --filter @ai-office/bff db:push
pnpm --filter @ai-office/bff db:seed:billing
```

按仓库既有方式启动（示例，Windows PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

确认 `GET http://localhost:4001/health` 返回 `{"ok":true}`。

- [ ] **Step 3: 注册并查看摘要**

```bash
BASE=http://localhost:4000
EMAIL="m5a-$(date +%s)@example.com"
TOKEN=$(curl -s -X POST $BASE/api/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Passw0rd!\"}" | python -c "import sys,json;print(json.load(sys.stdin)['token'])")

curl -s $BASE/api/billing/summary -H "authorization: Bearer $TOKEN"
```

Expected：`plan.id=free`、`balance=500`、`reserved=0`、`subscription.status=active`。

- [ ] **Step 4: 发起一次运行并核对账本**

```bash
SID=$(curl -s -X POST $BASE/api/sessions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' | python -c "import sys,json;print(json.load(sys.stdin)['id'])")

curl -sN -X POST $BASE/api/sessions/$SID/tasks -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"goal":"用三句话介绍你自己"}'
```

Expected：SSE 出现 `step`、`usage`（`models` 数组）、`done`。

```bash
curl -s "$BASE/api/billing/ledger?limit=10" -H "authorization: Bearer $TOKEN"
curl -s "$BASE/api/billing/usage?groupBy=model" -H "authorization: Bearer $TOKEN"
curl -s $BASE/api/billing/summary -H "authorization: Bearer $TOKEN"
```

Expected：流水含 `grant +500` 与 `consume -1`（mock/真实模型用量均至少 1 积分）；summary 的 `balance` = 500 - 实际扣费；`reserved` 回到 0。

- [ ] **Step 5: 验证 402 与 429**

管理员提权并收回积分：

```bash
pnpm --filter @ai-office/bff admin:promote -- "$EMAIL"
# 重新登录拿到带最新角色校验的 token（角色从库读取，旧 token 亦可）
ADMIN_TOKEN=$TOKEN
curl -s -X POST $BASE/api/billing/admin/credits -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"amount":-500,"note":"测试清零"}'

curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/sessions/$SID/tasks \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"再跑一次"}'
```

Expected：`402`，响应 `{"error":"insufficient_credits"}`。

再发放 `1000` 积分并把 free 套餐 RPM 临时调低（或连续快速发起 11 次）验证 `429`：至少一次返回 `429` 且带 `retry-after` 头；随后停止请求。

- [ ] **Step 6: 验证重复结算幂等**

```bash
RUN_ID=$(curl -s "$BASE/api/billing/ledger?limit=10" -H "authorization: Bearer $TOKEN" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(next(i['runId'] for i in d['items'] if i['type']=='consume'))")

psql "postgresql://ai_office:ai_office@localhost:5432/ai_office" -c \
  "select \"runId\", status, credits from \"UsageRecord\" where \"runId\"='$RUN_ID';"
```

Expected：1 行、`settled`、`credits` 与流水一致；再次触发补偿扫描（等待 1 分钟、或重启 BFF）后 `CreditTx` 中该 `runId` 仍只有一条 consume。

- [ ] **Step 7: 浏览器验收**

打开 `http://localhost:3000/billing`：

- 未登录跳转 `/login`；登录后显示免费套餐、500 额度、周期时间。
- 套餐目录 4 档，当前套餐高亮。
- 流水表显示发放与消耗，数字正负颜色正确。
- 「按日 / 按模型」切换后表格数据变化。
- 触发预算超限（把 `ModelPrice` 临时调高或把 free `maxCreditsPerRun` 调低）后运行，工作台出现 `提示：本次运行已达到积分预算上限，已停止`。

如发现任何一步与预期不符，回到对应 Task 修复并重新跑该 Task 的测试，不要跳过。

- [ ] **Step 8: 最终提交（如有验收期间的修复）**

```bash
git status --short
git add <修复的文件>
git commit -m "fix(billing): 端到端验收问题修复"
```

若无需修复，本 Task 不产生提交。

---

## 计划自检

- **Spec 覆盖**：数据模型（Task 1）、shared 契约（Task 2）、多模型路由/fallback（Task 3）、预算与按模型用量（Task 4）、积分换算/扣减顺序（Task 5）、预占/结算/过期/补偿（Task 6）、限流与查询/管理接口（Task 7）、tasks 接入与断连排空（Task 8）、注册开通与 sweeper（Task 9）、Web `/billing` 与 notice（Task 10）、部署/开发/里程碑文档（Task 11）、回归与 E2E（Task 12）。
- **非目标**：支付/发票/退款、加油包购买入口、企业共享积分池、管理后台 UI、可观测/队列——均未排入任务。
- **类型一致性**：`RunBilling`（shared）= `RunRequest.billing` = runtime `RunDeps.billing` = `BillingService.beginRun` 返回值；`UsageEvent` 全链路同名；`ModelPriceDto` 同时被 runtime 计价与 BFF 聚合使用。
- **幂等键**：`UsageRecord.runId`、`CreditTx.runId`、`CreditHold.runId` 三处唯一/主键，重复结算与重复预占都不会叠加。
