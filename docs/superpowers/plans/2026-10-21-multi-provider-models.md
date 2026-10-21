# 多厂商模型配置、启用开关与客户端模型选择 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运营平台管理多家模型厂商、模型目录、启用状态与默认模型，并让 Web 端在新建任务时从当前套餐可用模型中选一个，运行链路按选中模型调用、失败自动回退且按实际模型计费。

**Architecture:** BFF 新增 `ModelCatalogService`，按「全局启用模型 ∩ 套餐 allowedModels」解析可用模型；每次运行前解密该厂商 API Key，把有序的 `modelRoutes` 随 `RunRequest` 下发给 runtime。runtime 保持无数据库依赖，按本次路由临时构建 `RoutingGateway`，复用现有 429/5xx 回退逻辑。密钥沿用 AES-256-GCM 格式，模型厂商使用独立的 `MODEL_ENC_KEY`。

**Tech Stack:** pnpm workspace + Turborepo、NestJS/Fastify BFF、Prisma/PostgreSQL、Next.js 15 / React 19、Vitest、Node.js 22。

**设计文档：** `docs/superpowers/specs/2026-10-21-multi-provider-models-design.md`

**执行约定：**
- 切换分支前先确认：本仓库**直接在 `master` 开发**，不建特性分支、不提 PR。
- 所有 commit message 用中文，格式 `type(scope): 中文摘要`，正文解释「为什么改」。
- **绝对不要 `git add apps/bff/prisma/comments.sql`**：该文件有与本需求无关的未提交改动。
- 中间任务的完整 `pnpm -r test` 可能因后续任务尚未完成而失败；每个任务只要求本任务列出的测试通过，最终由任务 11 跑全量。
- 任何日志、审计、DTO、错误信息中都不得出现明文 API Key。

---

## 文件结构总览

**新建：**
- `apps/bff/src/secrets/secret-box.ts`：按环境变量名取密钥的 AES-256-GCM 加解密。
- `apps/bff/src/secrets/secret-box.test.ts`
- `apps/bff/src/models/model.constants.ts`：`MODEL_ENC_KEY`、`defaultModel` 设置键。
- `apps/bff/src/models/model.errors.ts`：模型目录相关 HTTP 异常。
- `apps/bff/src/models/env-providers.ts`：兼容 `MODEL_PROVIDERS` / `DEEPSEEK_API_KEY` 的环境变量解析。
- `apps/bff/src/models/env-providers.test.ts`
- `apps/bff/src/models/model-catalog.service.ts`：可用模型解析、默认模型、运行路由解密。
- `apps/bff/src/models/model-catalog.service.test.ts`
- `apps/bff/src/models/models.controller.ts`：`GET /api/models`。
- `apps/bff/src/models/models.module.ts`
- `apps/bff/src/admin/admin-models.controller.test.ts`

**重写：**
- `apps/bff/src/admin/admin-models.service.ts`
- `apps/bff/src/admin/admin-models.controller.ts`
- `apps/bff/src/admin/admin-models.service.test.ts`
- `apps/admin/src/app/(console)/models/page.tsx`

**修改：**
- `apps/bff/prisma/schema.prisma`
- `packages/shared/src/dto.ts`
- `apps/bff/src/connector/crypto.ts`
- `apps/bff/src/main.ts`
- `apps/bff/src/app.module.ts`
- `apps/bff/src/billing/billing.service.ts`（`modelPrice` → `modelConfig`）
- `apps/bff/src/metrics/metrics.sweeper.ts`（同上）
- `apps/bff/scripts/seed-billing.mjs`（同上）
- `apps/bff/src/sessions/sessions.service.ts` / `sessions.service.test.ts`
- `apps/bff/src/tasks/tasks.service.ts` / `tasks.controller.ts` / `tasks.controller.test.ts`
- `apps/agent-runtime/src/model/create-gateway.ts` / `create-gateway.test.ts`
- `apps/agent-runtime/src/server.ts` / `server.test.ts`
- `apps/agent-runtime/src/agent-loop.ts` / `agent-loop.test.ts`
- `apps/web/src/lib/api.ts` / `api.test.ts`
- `apps/web/src/app/page.tsx`
- `apps/web/src/lib/session-filter.test.ts`
- `packages/web-core/src/errors.ts` / `errors.test.ts`（若存在）
- `packages/web-core/src/globals.css`
- `apps/admin/src/lib/admin-api.ts` / `admin-api.test.ts`
- `apps/admin/src/app/(console)/plans/page.tsx`
- `.env.example` / `.env.docker.example` / `scripts/deploy.sh` / `docs/deploy/06-deployment.md`

---

## Task 1：通用密钥盒子与 `MODEL_ENC_KEY` 启动自检

**Files:**
- Create: `apps/bff/src/secrets/secret-box.ts`
- Create: `apps/bff/src/secrets/secret-box.test.ts`
- Modify: `apps/bff/src/connector/crypto.ts`
- Modify: `apps/bff/src/main.ts`

- [ ] **Step 1: 写失败的 secret-box 测试**

创建 `apps/bff/src/secrets/secret-box.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { assertSecretKey, decryptSecret, encryptSecret } from './secret-box';

const KEY = 'a'.repeat(64); // 32 字节 hex

beforeEach(() => {
  process.env.TEST_ENC_KEY = KEY;
});

describe('secret-box', () => {
  it('加解密往返且密文不含明文', () => {
    const plain = JSON.stringify({ apiKey: 'sk-1', note: '中文✓' });
    const blob = encryptSecret(plain, 'TEST_ENC_KEY');
    expect(blob).not.toContain('sk-1');
    expect(decryptSecret(blob, 'TEST_ENC_KEY')).toBe(plain);
  });

  it('同一明文两次加密产生不同密文（随机 IV）', () => {
    expect(encryptSecret('x', 'TEST_ENC_KEY')).not.toBe(encryptSecret('x', 'TEST_ENC_KEY'));
  });

  it('密文被篡改时解密抛错', () => {
    const blob = encryptSecret('secret', 'TEST_ENC_KEY');
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptSecret(raw.toString('base64'), 'TEST_ENC_KEY')).toThrow();
  });

  it('换密钥后解不开（认证失败）', () => {
    const blob = encryptSecret('secret', 'TEST_ENC_KEY');
    process.env.TEST_ENC_KEY = 'b'.repeat(64);
    expect(() => decryptSecret(blob, 'TEST_ENC_KEY')).toThrow();
  });

  it('assertSecretKey 缺密钥或长度错时抛带环境变量名的错误', () => {
    delete process.env.TEST_ENC_KEY;
    expect(() => assertSecretKey('TEST_ENC_KEY')).toThrow('TEST_ENC_KEY 未设置');
    process.env.TEST_ENC_KEY = 'abcd';
    expect(() => assertSecretKey('TEST_ENC_KEY')).toThrow('TEST_ENC_KEY 必须是 32 字节 hex');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/secrets/secret-box.test.ts`

Expected: FAIL，报 `Cannot find module './secret-box'`。

- [ ] **Step 3: 实现 secret-box**

创建 `apps/bff/src/secrets/secret-box.ts`：

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** 读密钥并校验；缺或非 32 字节 hex 即抛错（fail-fast）。 */
function key(envName: string): Buffer {
  const hex = process.env[envName];
  if (!hex) throw new Error(`${envName} 未设置`);
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error(`${envName} 必须是 32 字节 hex`);
  return buf;
}

/** 启动期自检：缺/非法密钥直接崩，避免运行到首次读写密文才暴露。 */
export function assertSecretKey(envName: string): void {
  key(envName);
}

/** 加密为 base64(IV ‖ authTag ‖ ciphertext)；不同环境变量可使用不同密钥。 */
export function encryptSecret(plain: string, envName: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(envName), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** 解密 base64(IV ‖ authTag ‖ ciphertext)；篡改/换密钥时抛错。 */
export function decryptSecret(blob: string, envName: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(envName), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-office/bff test -- src/secrets/secret-box.test.ts`

Expected: PASS（5 个用例全部通过）。

- [ ] **Step 5: 让连接器加解密委托给 secret-box**

把 `apps/bff/src/connector/crypto.ts` 整体替换为：

```ts
import { assertSecretKey, decryptSecret, encryptSecret } from '../secrets/secret-box';

const ENV_NAME = 'CONNECTOR_ENC_KEY';

/** 启动期自检：缺/非法密钥直接崩，避免运行到首次写连接器才暴露。 */
export function assertConnectorKey(): void {
  assertSecretKey(ENV_NAME);
}

/** 加密为 base64(IV ‖ authTag ‖ ciphertext)。 */
export function encrypt(plain: string): string {
  return encryptSecret(plain, ENV_NAME);
}

/** 解密 base64(IV ‖ authTag ‖ ciphertext)；篡改/换密钥时抛错。 */
export function decrypt(blob: string): string {
  return decryptSecret(blob, ENV_NAME);
}
```

- [ ] **Step 6: 启动时同时校验模型密钥**

修改 `apps/bff/src/main.ts`：

导入区在 `import { assertConnectorKey } from './connector/crypto';` 下方增加：

```ts
import { assertSecretKey } from './secrets/secret-box';
```

把 `bootstrap()` 开头改为：

```ts
async function bootstrap(): Promise<void> {
  assertConnectorKey();
  // 模型厂商 Key 与连接器密钥互不复用：轮换其中一把不会影响另一类密文。
  assertSecretKey('MODEL_ENC_KEY');
  const app = await NestFactory.create<NestFastifyApplication>(
```

- [ ] **Step 7: 回归连接器加密测试与类型检查**

Run:

```bash
pnpm --filter @ai-office/bff test -- src/connector/crypto.test.ts src/secrets/secret-box.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: 两个测试文件全部 PASS；typecheck 无输出。

- [ ] **Step 8: 提交**

```bash
git add apps/bff/src/secrets/secret-box.ts apps/bff/src/secrets/secret-box.test.ts apps/bff/src/connector/crypto.ts apps/bff/src/main.ts
git commit -m "refactor(bff): 抽出通用密钥盒子并校验模型密钥

连接器与模型厂商需要各自独立的加密密钥，原 crypto 把 CONNECTOR_ENC_KEY
写死，无法复用。抽成按环境变量名取密钥的通用实现，并在启动时同时校验
MODEL_ENC_KEY，避免运行到首次调用模型才暴露配置缺失。"
```

---

## Task 2：Schema、生成的 Prisma Client 与共享 DTO

**Files:**
- Modify: `apps/bff/prisma/schema.prisma`
- Modify: `packages/shared/src/dto.ts`
- Modify: `apps/bff/src/billing/billing.service.ts`
- Modify: `apps/bff/src/billing/billing.service.test.ts`
- Modify: `apps/bff/src/metrics/metrics.sweeper.ts`
- Modify: `apps/bff/src/metrics/metrics.sweeper.test.ts`
- Modify: `apps/bff/scripts/seed-billing.mjs`
- Modify: `apps/bff/src/admin/admin-models.service.ts`（仅机械改名，接口下一任务再换）
- Modify: `apps/bff/src/admin/admin-models.service.test.ts`（仅机械改名）
- Modify: `apps/bff/src/sessions/sessions.service.ts`（list/create 返回 `model`）
- Modify: `apps/bff/src/sessions/sessions.service.test.ts`
- Modify: `apps/web/src/lib/session-filter.test.ts`

- [ ] **Step 1: 修改 Prisma schema**

在 `apps/bff/prisma/schema.prisma` 中：

1. 给 `Session` 增加字段。**只插入下面两行**（放在 `status` 与 `createdAt` 之间），不要替换整个 model 块，避免误删既有关系与索引：

```prisma
  // 创建任务时选定的模型；历史会话为空，首次成功预占后回填。
  model     String?
```

2. 把 `model ModelPrice` 整段替换为下面两个模型：

```prisma
model ModelProvider {
  id         String        @id @default(uuid())
  name       String        @unique
  baseUrl    String
  apiKeyEnc  String
  apiKeyHint String?
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt
  models     ModelConfig[]
}

model ModelConfig {
  model                   String         @id
  providerId              String?
  displayName             String?
  enabled                 Boolean        @default(false)
  sortOrder               Int            @default(0)
  inputMilliCreditsPer1k  Int
  outputMilliCreditsPer1k Int
  updatedAt               DateTime       @updatedAt
  provider                ModelProvider? @relation(fields: [providerId], references: [id], onDelete: Restrict)

  // 保留原表名，存量价格行无需迁移数据。
  @@map("ModelPrice")
  @@index([providerId])
  @@index([enabled, sortOrder])
}
```

- [ ] **Step 2: 应用 schema 并生成 Client**

Run: `pnpm --filter @ai-office/bff db:push`

Expected: 输出 `Your database is now in sync with your Prisma schema.`，随后执行 `apply-comments.mjs` 且不报错。若本地数据库未启动，先运行 `pnpm --filter @ai-office/bff db:up`。

> 注意：本仓库没有 `prisma/migrations`，不要执行 `prisma migrate`。

- [ ] **Step 3: 机械替换 BFF 内的 `modelPrice` 引用**

逐文件修改：

`apps/bff/src/billing/billing.service.ts` 中 `loadPrices`：

```ts
  private async loadPrices(
    client: Db | PrismaService,
  ): Promise<Record<string, { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number }>> {
    const rows = await client.modelConfig.findMany();
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
```

`apps/bff/src/billing/billing.service.test.ts` 中 fake：

```ts
    modelConfig: { findMany: async () => [...db.prices] },
```

`apps/bff/src/metrics/metrics.sweeper.ts`：把 `this.prisma.modelPrice.findMany({` 改为 `this.prisma.modelConfig.findMany({`。

`apps/bff/src/metrics/metrics.sweeper.test.ts`：把 fake 的 `modelPrice:` 键改为 `modelConfig:`。

`apps/bff/scripts/seed-billing.mjs`：把 `prisma.modelPrice.upsert` 改为 `prisma.modelConfig.upsert`。

`apps/bff/src/admin/admin-models.service.ts`：
- `import type { ModelPrice } from '@prisma/client';` → `import type { ModelConfig } from '@prisma/client';`
- `function toDto(row: ModelPrice)` → `function toDto(row: ModelConfig)`
- 所有 `this.prisma.modelPrice` / `tx.modelPrice` → `this.prisma.modelConfig` / `tx.modelConfig`

`apps/bff/src/admin/admin-models.service.test.ts`：fake 的 `modelPrice:` 键改为 `modelConfig:`。

- [ ] **Step 4: 更新共享 DTO（只新增，不动旧管理端类型）**

修改 `packages/shared/src/dto.ts`：

1. `RunRequest` 末尾增加字段：

```ts
  /** 本次运行可用的模型路由（按优先级）；缺省时 runtime 使用启动时的静态网关。 */
  modelRoutes?: RunModelRoute[];
```

2. 在 `RunRequest` 之前增加：

```ts
/**
 * BFF 按运行时解密的厂商路由。
 * 只在下发给 runtime 的请求体中出现，绝不下发到浏览器。
 */
export interface RunModelRoute {
  model: string;
  baseUrl: string;
  apiKey: string;
}
```

3. `CreateSessionRequest` 改为：

```ts
export interface CreateSessionRequest {
  title?: string;
  /** 新建任务时选定的模型；缺省用运营端默认模型。 */
  model?: string;
}
```

4. `SessionSummary` 增加：

```ts
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  /** 会话固定使用的模型；历史会话在首次运行后回填。 */
  model: string | null;
}
```

5. `RunBilling` 增加：

```ts
export interface RunBilling {
  maxCredits: number;
  allowedModels: string[];
  /** 用户本次选中的模型；runtime 据此把它排到候选第一位。 */
  selectedModel?: string;
  prices: Record<string, ModelPriceDto>;
}
```

6. 在 `ModelPriceDto` 定义之后增加客户端模型列表 DTO：

```ts
/** Web 端模型选择器的一项；不含 Base URL、密钥或内部 ID。 */
export interface ClientModelDto {
  model: string;
  displayName: string;
  providerName: string;
}

/** `GET /api/models` 响应：仅当前套餐可用的已启用模型。 */
export interface ClientModelsDto {
  models: ClientModelDto[];
  defaultModel: string | null;
}
```

- [ ] **Step 5: 让会话列表/创建返回 `model`**

修改 `apps/bff/src/sessions/sessions.service.ts`：

```ts
  async list(tenantId: string, userId: string): Promise<SessionSummary[]> {
    // 归档会话对普通用户不可见。
    const rows = await this.prisma.session.findMany({
      where: { tenantId, userId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      model: s.model ?? null,
    }));
  }

  async create(
    tenantId: string,
    userId: string,
    req: CreateSessionRequest,
  ): Promise<SessionSummary> {
    const s = await this.prisma.session.create({
      data: { tenantId, userId, title: req.title ?? '新会话' },
    });
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      model: s.model ?? null,
    };
  }
```

- [ ] **Step 6: 更新受类型变更影响的测试夹具**

`apps/web/src/lib/session-filter.test.ts` 的 `SESSIONS` 增加 `model: null`：

```ts
const SESSIONS: SessionSummary[] = [
  { id: '1', title: '写一份周报', createdAt: '2026-10-21T04:00:00.000Z', model: null },
  { id: '2', title: '调研竞品 WorkBuddy', createdAt: '2026-10-20T04:00:00.000Z', model: null },
  { id: '3', title: '生成演示稿', createdAt: '2026-10-19T04:00:00.000Z', model: null },
];
```

`apps/bff/src/sessions/sessions.service.test.ts` 的 `all` 增加 `model: null`：

```ts
const all = [
  { id: 's1', tenantId: 't1', userId: 'u1', title: 'active', status: 'active', model: null, createdAt: new Date() },
  { id: 's2', tenantId: 't1', userId: 'u1', title: 'archived', status: 'archived', model: null, createdAt: new Date() },
];
```

- [ ] **Step 7: 运行受影响测试与类型检查**

Run:

```bash
pnpm --filter @ai-office/shared build
pnpm --filter @ai-office/bff test
pnpm --filter @ai-office/bff typecheck
pnpm --filter @ai-office/web test -- src/lib/session-filter.test.ts
```

Expected: 全部通过；若 `pnpm --filter @ai-office/web test` 因其它测试文件未更新而失败，只要求本步指定的 `session-filter.test.ts` 通过。

- [ ] **Step 8: 提交**

```bash
git add apps/bff/prisma/schema.prisma packages/shared/src/dto.ts \
  apps/bff/src/billing/billing.service.ts apps/bff/src/billing/billing.service.test.ts \
  apps/bff/src/metrics/metrics.sweeper.ts apps/bff/src/metrics/metrics.sweeper.test.ts \
  apps/bff/scripts/seed-billing.mjs \
  apps/bff/src/admin/admin-models.service.ts apps/bff/src/admin/admin-models.service.test.ts \
  apps/bff/src/sessions/sessions.service.ts apps/bff/src/sessions/sessions.service.test.ts \
  apps/web/src/lib/session-filter.test.ts
git commit -m "feat(db): 增加模型厂商与会话模型字段

模型配置需要支持多厂商、启用状态和展示排序，同时保留存量价格表。
新增 ModelProvider，并把 ModelPrice 扩展为映射同名表的 ModelConfig，
避免迁移存量数据；Session 记录创建时选定的模型，为按会话固定模型铺路。"
```

---

## Task 3：环境变量模型解析与常量

**Files:**
- Create: `apps/bff/src/models/model.constants.ts`
- Create: `apps/bff/src/models/env-providers.ts`
- Create: `apps/bff/src/models/env-providers.test.ts`

- [ ] **Step 1: 写环境变量解析测试**

创建 `apps/bff/src/models/env-providers.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { listEnvProviderGroups, parseEnvModelProviders } from './env-providers';

describe('parseEnvModelProviders', () => {
  it('解析 MODEL_PROVIDERS 并按 apiKeyEnv 取名与密钥', () => {
    const out = parseEnvModelProviders({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'https://x/v1/', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'https://y/v1', apiKeyEnv: 'KEY_A' },
      ]),
      KEY_A: 'sk-a',
    });
    expect(out).toEqual([
      { name: 'KEY_A', model: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-a' },
      { name: 'KEY_A', model: 'b', baseUrl: 'https://y/v1', apiKey: 'sk-a' },
    ]);
  });

  it('非法 JSON / 非数组 / 空字段与重复模型被忽略', () => {
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: '{bad' })).toEqual([]);
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: '{}' })).toEqual([]);
    expect(
      parseEnvModelProviders({
        MODEL_PROVIDERS: JSON.stringify([
          { model: '', baseUrl: 'https://x/v1', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: '', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: 'https://y/v1', apiKeyEnv: 'K' },
        ]),
        K: 'sk',
      }),
    ).toEqual([{ name: 'K', model: 'a', baseUrl: 'https://x/v1', apiKey: 'sk' }]);
  });

  it('未配置 MODEL_PROVIDERS 时回退 DEEPSEEK_API_KEY 单模型', () => {
    expect(
      parseEnvModelProviders({
        DEEPSEEK_API_KEY: 'sk-d',
        MODEL_BASE_URL: 'https://d/v1/',
        MODEL_NAME: 'deepseek-reasoner',
      }),
    ).toEqual([
      {
        name: 'default',
        model: 'deepseek-reasoner',
        baseUrl: 'https://d/v1',
        apiKey: 'sk-d',
      },
    ]);
  });

  it('完全没有密钥时返回空数组（由 runtime 走 Mock）', () => {
    expect(parseEnvModelProviders({})).toEqual([]);
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: JSON.stringify([{ model: 'a', baseUrl: 'https://x', apiKeyEnv: 'MISSING' }]) })).toEqual([
      { name: 'MISSING', model: 'a', baseUrl: 'https://x', apiKey: '' },
    ]);
  });
});

describe('listEnvProviderGroups', () => {
  it('按 apiKeyEnv 归组且不泄露 baseUrl/密钥', () => {
    const groups = listEnvProviderGroups({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'http://secret-host', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'http://secret-host', apiKeyEnv: 'KEY_A' },
      ]),
    });
    expect(groups).toEqual([{ name: 'KEY_A', models: ['a', 'b'] }]);
    expect(JSON.stringify(groups)).not.toContain('secret-host');
  });

  it('什么都没配时展示运行时兜底的模型名', () => {
    expect(listEnvProviderGroups({ MODEL_NAME: 'deepseek-chat' })).toEqual([
      { name: 'default', models: ['deepseek-chat'] },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/models/env-providers.test.ts`

Expected: FAIL，报 `Cannot find module './env-providers'`。

- [ ] **Step 3: 实现常量和解析器**

创建 `apps/bff/src/models/model.constants.ts`：

```ts
/** 模型厂商 API Key 的加密密钥；与连接器密钥分离，独立轮换。 */
export const MODEL_ENC_KEY = 'MODEL_ENC_KEY';

/** Setting 表中保存全局默认模型的键；不进入 SETTING_SPECS 白名单。 */
export const DEFAULT_MODEL_SETTING_KEY = 'defaultModel';
```

创建 `apps/bff/src/models/env-providers.ts`：

```ts
import type { AdminLegacyProviderDto } from '@ai-office/shared';

export interface EnvModelProvider {
  /** 展示用分组名：优先 apiKeyEnv；单模型配置为 default。不含密钥。 */
  name: string;
  model: string;
  baseUrl: string;
  /** 未配置对应环境变量时为空串；调用方据此判断能否真正发请求。 */
  apiKey: string;
}

export const DEFAULT_ENV_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_ENV_MODEL = 'deepseek-chat';

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/**
 * 与 runtime 的 MODEL_PROVIDERS 语义保持一致：
 * MODEL_PROVIDERS → DEEPSEEK_API_KEY + MODEL_NAME → 空（runtime 走 Mock）。
 * BFF 侧对非法配置保持宽容：管理端仍需可用，真正调用由 runtime 失败关闭。
 */
export function parseEnvModelProviders(env: NodeJS.ProcessEnv): EnvModelProvider[] {
  const raw = env.MODEL_PROVIDERS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: EnvModelProvider[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;
      if (typeof p.model !== 'string' || p.model === '') continue;
      if (typeof p.baseUrl !== 'string' || p.baseUrl === '') continue;
      if (typeof p.apiKeyEnv !== 'string' || p.apiKeyEnv === '') continue;
      if (seen.has(p.model)) continue;
      seen.add(p.model);
      out.push({
        name: p.apiKeyEnv,
        model: p.model,
        baseUrl: normalizeBaseUrl(p.baseUrl),
        apiKey: env[p.apiKeyEnv] ?? '',
      });
    }
    return out;
  }
  if (!env.DEEPSEEK_API_KEY) return [];
  return [
    {
      name: 'default',
      model: env.MODEL_NAME || DEFAULT_ENV_MODEL,
      baseUrl: normalizeBaseUrl(env.MODEL_BASE_URL || DEFAULT_ENV_BASE_URL),
      apiKey: env.DEEPSEEK_API_KEY,
    },
  ];
}

/** 管理端兜底展示：只保留分组名与模型名，绝不暴露 baseUrl 或密钥。 */
export function listEnvProviderGroups(env: NodeJS.ProcessEnv): AdminLegacyProviderDto[] {
  const entries = parseEnvModelProviders(env);
  if (entries.length === 0) {
    return [{ name: 'default', models: [env.MODEL_NAME || DEFAULT_ENV_MODEL] }];
  }
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    groups.set(e.name, [...(groups.get(e.name) ?? []), e.model]);
  }
  return [...groups].map(([name, models]) => ({ name, models }));
}
```

> 该文件依赖的 `AdminLegacyProviderDto` 在 Task 8 才加入 DTO。为了让本任务可独立通过，先在 `packages/shared/src/dto.ts` 的旧 `AdminModelProviderDto` 定义下方临时加入该类型：

```ts
/** 环境变量兜底 provider（仅管理端展示，不含 baseUrl/密钥）。 */
export interface AdminLegacyProviderDto {
  name: string;
  models: string[];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm --filter @ai-office/shared build
pnpm --filter @ai-office/bff test -- src/models/env-providers.test.ts
```

Expected: PASS（6 个用例全部通过）。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/models/model.constants.ts apps/bff/src/models/env-providers.ts apps/bff/src/models/env-providers.test.ts packages/shared/src/dto.ts
git commit -m "feat(bff): 解析兼容模型的环境变量配置

运营端未配置数据库厂商时，仍需沿用现有的 MODEL_PROVIDERS 与
DEEPSEEK_API_KEY 兜底，保证升级期间与本地开发不受影响。
解析逻辑对非法配置保持宽容，并只向管理端暴露分组名和模型名。"
```

---

## Task 4：模型目录服务与客户端 `/api/models`

**Files:**
- Create: `apps/bff/src/models/model.errors.ts`
- Create: `apps/bff/src/models/model-catalog.service.ts`
- Create: `apps/bff/src/models/model-catalog.service.test.ts`
- Create: `apps/bff/src/models/models.controller.ts`
- Create: `apps/bff/src/models/models.module.ts`
- Modify: `apps/bff/src/app.module.ts`

- [ ] **Step 1: 写失败的模型目录测试**

创建 `apps/bff/src/models/model-catalog.service.test.ts`：

```ts
import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModelCatalogService } from './model-catalog.service';
import { encryptSecret } from '../secrets/secret-box';
import {
  ModelPlanExpiredError,
  ModelProviderUnavailableError,
  ModelUnavailableError,
  NoModelsAvailableError,
} from './model.errors';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../db/prisma.service';

const KEY = 'c'.repeat(64);

beforeEach(() => {
  process.env.MODEL_ENC_KEY = KEY;
  delete process.env.MODEL_PROVIDERS;
  delete process.env.DEEPSEEK_API_KEY;
});

function makeService(opts: {
  providers?: { id: string; name: string; baseUrl: string; apiKeyEnc: string }[];
  models?: { model: string; providerId: string | null; enabled: boolean; sortOrder: number; displayName: string | null; inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number; updatedAt: Date }[];
  allowed?: string[];
  defaultModel?: string | null;
  expired?: boolean;
} = {}) {
  const providers = opts.providers ?? [];
  const models = opts.models ?? [];
  const prisma = {
    modelProvider: {
      count: async () => providers.length,
      findMany: async () => [],
    },
    modelConfig: {
      findMany: async () =>
        models.map((m) => ({ ...m, provider: providers.find((p) => p.id === m.providerId) ?? null })),
    },
    setting: {
      findUnique: async () =>
        opts.defaultModel ? { key: 'defaultModel', value: opts.defaultModel } : null,
    },
  } as unknown as PrismaService;
  const billing = {
    ensureSubscription: async () => ({
      plan: { id: 'free', allowedModels: opts.allowed ?? ['m1', 'm2'] },
      sub: {
        status: opts.expired ? 'expired' : 'active',
        periodEnd: opts.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 86_400_000),
      },
    }),
  } as unknown as BillingService;
  return new ModelCatalogService(prisma, billing);
}

const dbProvider = {
  id: 'p1',
  name: '豆包',
  baseUrl: 'https://ark.example/v3',
  apiKeyEnc: encryptSecret('sk-ark', 'MODEL_ENC_KEY'),
};

const dbModels = [
  {
    model: 'm2',
    providerId: 'p1',
    enabled: true,
    sortOrder: 20,
    displayName: '模型二',
    inputMilliCreditsPer1k: 1,
    outputMilliCreditsPer1k: 2,
    updatedAt: new Date(),
  },
  {
    model: 'm1',
    providerId: 'p1',
    enabled: true,
    sortOrder: 10,
    displayName: null,
    inputMilliCreditsPer1k: 3,
    outputMilliCreditsPer1k: 4,
    updatedAt: new Date(),
  },
  {
    model: 'm3',
    providerId: 'p1',
    enabled: true,
    sortOrder: 30,
    displayName: '不在套餐',
    inputMilliCreditsPer1k: 1,
    outputMilliCreditsPer1k: 1,
    updatedAt: new Date(),
  },
];

describe('ModelCatalogService', () => {
  it('数据库厂商优先，与套餐交集并按 sortOrder 排序', async () => {
    const svc = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2', 'm3', 'legacy'],
    });
    const out = await svc.listForClient('t1');
    expect(out.models.map((m) => m.model)).toEqual(['m1', 'm2', 'm3']);
    expect(out.models[0]).toEqual({ model: 'm1', displayName: 'm1', providerName: '豆包' });
  });

  it('默认模型取运营端设置；不在可用列表时回退第一项', async () => {
    const chosen = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2'],
      defaultModel: 'm2',
    });
    expect((await chosen.listForClient('t1')).defaultModel).toBe('m2');

    const stale = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2'],
      defaultModel: 'gone',
    });
    expect((await stale.listForClient('t1')).defaultModel).toBe('m1');
  });

  it('套餐过期返回 402', async () => {
    const svc = makeService({ expired: true });
    await expect(svc.listForClient('t1')).rejects.toBeInstanceOf(ModelPlanExpiredError);
  });

  it('没有数据库厂商时回退环境变量；无密钥时展示套餐模型供 Mock 使用', async () => {
    process.env.MODEL_PROVIDERS = JSON.stringify([
      { model: 'm1', baseUrl: 'https://env/v1', apiKeyEnv: 'ENV_KEY' },
      { model: 'm2', baseUrl: 'https://env/v1', apiKeyEnv: 'ENV_KEY' },
    ]);
    process.env.ENV_KEY = 'sk-env';
    const envSvc = makeService({ allowed: ['m1', 'm2', 'm3'] });
    const out = await envSvc.listForClient('t1');
    expect(out.models.map((m) => m.model)).toEqual(['m1', 'm2']);
    expect(out.models[0].providerName).toBe('环境变量');

    delete process.env.ENV_KEY;
    const mockSvc = makeService({ allowed: ['m1', 'm2'] });
    expect((await mockSvc.listForClient('t1')).models.map((m) => m.model)).toEqual(['m1', 'm2']);
  });

  it('resolveForRun 把选中模型排第一并解密厂商密钥', async () => {
    const svc = makeService({
      providers: [dbProvider],
      models: dbModels,
      allowed: ['m1', 'm2'],
      defaultModel: 'm2',
    });
    const out = await svc.resolveForRun('t1', null);
    expect(out.selectedModel).toBe('m2');
    expect(out.modelRoutes).toEqual([
      { model: 'm2', baseUrl: 'https://ark.example/v3', apiKey: 'sk-ark' },
      { model: 'm1', baseUrl: 'https://ark.example/v3', apiKey: 'sk-ark' },
    ]);
  });

  it('会话选定模型不在可用列表返回 409；无可用模型返回 400', async () => {
    const svc = makeService({ providers: [dbProvider], models: dbModels, allowed: ['m1', 'm2'] });
    await expect(svc.resolveForRun('t1', 'gone')).rejects.toBeInstanceOf(ModelUnavailableError);

    const empty = makeService({ providers: [], models: [], allowed: [] });
    await expect(empty.resolveForRun('t1', null)).rejects.toBeInstanceOf(NoModelsAvailableError);
  });

  it('选中模型密钥损坏返回 503；其它厂商密钥损坏只跳过该路由', async () => {
    const broken = { ...dbProvider, apiKeyEnc: 'not-a-valid-blob' };
    const selected = makeService({
      providers: [broken],
      models: dbModels.slice(0, 1),
      allowed: ['m2'],
    });
    await expect(selected.resolveForRun('t1', 'm2')).rejects.toBeInstanceOf(
      ModelProviderUnavailableError,
    );

    // 选中模型 m2 在健康厂商 p1，回退模型 m3 在密钥损坏的 p2：
    // 本次运行应当成功，只丢掉 m3 这条回退路由。
    const fallbackBroken = makeService({
      providers: [
        dbProvider,
        {
          id: 'p2',
          name: '千问',
          baseUrl: 'https://dashscope.example/v1',
          apiKeyEnc: 'not-a-valid-blob',
        },
      ],
      models: [dbModels[0], { ...dbModels[2], providerId: 'p2' }],
      allowed: ['m2', 'm3'],
    });
    const out = await fallbackBroken.resolveForRun('t1', 'm2');
    expect(out.selectedModel).toBe('m2');
    expect(out.modelRoutes).toEqual([
      { model: 'm2', baseUrl: 'https://ark.example/v3', apiKey: 'sk-ark' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/models/model-catalog.service.test.ts`

Expected: FAIL，报 `Cannot find module './model-catalog.service'`。

- [ ] **Step 3: 实现异常类型**

创建 `apps/bff/src/models/model.errors.ts`：

```ts
import { HttpException } from '@nestjs/common';

/** 套餐过期/未激活：客户端当前没有可用模型。 */
export class ModelPlanExpiredError extends HttpException {
  constructor() {
    super('plan_expired', 402);
  }
}

/** 当前套餐与全局启用模型的交集为空。 */
export class NoModelsAvailableError extends HttpException {
  constructor() {
    super('no_models_available', 400);
  }
}

/** 会话选定的模型已被停用/移出套餐。 */
export class ModelUnavailableError extends HttpException {
  constructor() {
    super('model_unavailable', 409);
  }
}

/** 选中模型的厂商密钥无法解密，无法发起本次运行。 */
export class ModelProviderUnavailableError extends HttpException {
  constructor() {
    super('model_provider_unavailable', 503);
  }
}
```

- [ ] **Step 4: 实现模型目录服务**

创建 `apps/bff/src/models/model-catalog.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { ClientModelDto, ClientModelsDto, RunModelRoute } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { BillingService } from '../billing/billing.service';
import { decryptSecret } from '../secrets/secret-box';
import { DEFAULT_MODEL_SETTING_KEY, MODEL_ENC_KEY } from './model.constants';
import { parseEnvModelProviders } from './env-providers';
import {
  ModelPlanExpiredError,
  ModelProviderUnavailableError,
  ModelUnavailableError,
  NoModelsAvailableError,
} from './model.errors';

type ModelSource =
  | { kind: 'db'; providerId: string; baseUrl: string; apiKeyEnc: string }
  | { kind: 'env'; baseUrl: string; apiKey: string }
  | { kind: 'mock' };

export interface AvailableModel {
  model: string;
  displayName: string;
  providerName: string;
  sortOrder: number;
  source: ModelSource;
}

export interface AvailableModels {
  models: AvailableModel[];
  defaultModel: string | null;
}

export interface RunModelResolution {
  selectedModel: string;
  modelRoutes: RunModelRoute[];
}

/**
 * 模型目录：把「全局启用模型」与「当前套餐 allowedModels」取交集。
 * 运营端已配置任何厂商时完全以数据库为准；否则回退环境变量，兼容存量部署。
 */
@Injectable()
export class ModelCatalogService {
  private readonly logger = new Logger(ModelCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async available(tenantId: string): Promise<AvailableModels> {
    const { plan, sub } = await this.billing.ensureSubscription(tenantId);
    if (sub.status !== 'active' || sub.periodEnd.getTime() <= Date.now()) {
      throw new ModelPlanExpiredError();
    }
    const providerCount = await this.prisma.modelProvider.count();
    const models =
      providerCount > 0 ? await this.loadDb(plan.allowedModels) : this.loadEnv(plan.allowedModels);
    const stored = await this.readDefaultModel();
    const defaultModel =
      stored && models.some((m) => m.model === stored) ? stored : (models[0]?.model ?? null);
    return { models, defaultModel };
  }

  /** 客户端可见列表：绝不包含 baseUrl、密钥、providerId。 */
  async listForClient(tenantId: string): Promise<ClientModelsDto> {
    const { models, defaultModel } = await this.available(tenantId);
    const out: ClientModelDto[] = models.map((m) => ({
      model: m.model,
      displayName: m.displayName,
      providerName: m.providerName,
    }));
    return { models: out, defaultModel };
  }

  /**
   * 运行前解析：校验会话模型仍然可用，解密所有可用厂商的 Key，
   * 并把选中模型排到路由第一位，供 runtime 回退时按运营端排序尝试。
   */
  async resolveForRun(tenantId: string, sessionModel: string | null): Promise<RunModelResolution> {
    const { models, defaultModel } = await this.available(tenantId);
    if (models.length === 0) throw new NoModelsAvailableError();
    const selected = sessionModel ?? defaultModel ?? models[0].model;
    const selectedEntry = models.find((m) => m.model === selected);
    if (!selectedEntry) throw new ModelUnavailableError();

    const ordered = [selectedEntry, ...models.filter((m) => m.model !== selected)];
    const routes: RunModelRoute[] = [];
    const keyCache = new Map<string, string>();
    for (const entry of ordered) {
      if (entry.source.kind === 'mock') continue;
      if (entry.source.kind === 'env') {
        routes.push({
          model: entry.model,
          baseUrl: entry.source.baseUrl,
          apiKey: entry.source.apiKey,
        });
        continue;
      }
      try {
        let apiKey = keyCache.get(entry.source.providerId);
        if (apiKey === undefined) {
          apiKey = decryptSecret(entry.source.apiKeyEnc, MODEL_ENC_KEY);
          keyCache.set(entry.source.providerId, apiKey);
        }
        routes.push({ model: entry.model, baseUrl: entry.source.baseUrl, apiKey });
      } catch {
        // 单把密钥损坏只影响该厂商；选中的模型不可用时整体失败，避免静默换厂商。
        if (entry.model === selected) {
          this.logger.error(`模型 ${selected} 的厂商密钥无法解密`);
          throw new ModelProviderUnavailableError();
        }
        this.logger.warn(`跳过厂商 ${entry.source.providerId} 的模型 ${entry.model}：密钥无法解密`);
      }
    }
    return { selectedModel: selected, modelRoutes: routes };
  }

  private async loadDb(allowed: string[]): Promise<AvailableModel[]> {
    const rows = await this.prisma.modelConfig.findMany({
      where: { enabled: true, providerId: { not: null } },
      include: { provider: true },
      orderBy: [{ sortOrder: 'asc' }, { model: 'asc' }],
    });
    return rows.flatMap((row) => {
      const provider = row.provider;
      if (!provider || !allowed.includes(row.model)) return [];
      return [
        {
          model: row.model,
          displayName: row.displayName ?? row.model,
          providerName: provider.name,
          sortOrder: row.sortOrder,
          source: {
            kind: 'db' as const,
            providerId: provider.id,
            baseUrl: provider.baseUrl,
            apiKeyEnc: provider.apiKeyEnc,
          },
        },
      ];
    });
  }

  private loadEnv(allowed: string[]): AvailableModel[] {
    const configured = parseEnvModelProviders(process.env).filter(
      (p) => p.apiKey !== '' && allowed.includes(p.model),
    );
    if (configured.length > 0) {
      return configured.map((p) => ({
        model: p.model,
        displayName: p.model,
        providerName: '环境变量',
        sortOrder: 0,
        source: { kind: 'env' as const, baseUrl: p.baseUrl, apiKey: p.apiKey },
      }));
    }
    // 无任何可用密钥：runtime 会回退 MockGateway，仍展示套餐模型供本地/CI 验证链路。
    return allowed.map((model) => ({
      model,
      displayName: model,
      providerName: '环境变量',
      sortOrder: 0,
      source: { kind: 'mock' as const },
    }));
  }

  private async readDefaultModel(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({
      where: { key: DEFAULT_MODEL_SETTING_KEY },
    });
    return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
  }
}
```

- [ ] **Step 5: 实现控制器与模块**

创建 `apps/bff/src/models/models.controller.ts`：

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ClientModelsDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { ModelCatalogService } from './model-catalog.service';

/** 当前登录用户可选的模型：只返回已启用且在本套餐内的项。 */
@Controller('api')
@UseGuards(JwtGuard)
export class ModelsController {
  constructor(private readonly catalog: ModelCatalogService) {}

  @Get('models')
  list(@CurrentUser() user: JwtPayload): Promise<ClientModelsDto> {
    return this.catalog.listForClient(user.tenantId);
  }
}
```

创建 `apps/bff/src/models/models.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ModelCatalogService } from './model-catalog.service';
import { ModelsController } from './models.controller';

@Module({
  imports: [BillingModule],
  controllers: [ModelsController],
  providers: [ModelCatalogService],
  exports: [ModelCatalogService],
})
export class ModelsModule {}
```

修改 `apps/bff/src/app.module.ts`：

```ts
import { ModelsModule } from './models/models.module';
```

并把 `ModelsModule` 放进 `imports`（放在 `BillingModule` 之后）：

```ts
    BillingModule,
    ModelsModule,
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
pnpm --filter @ai-office/bff test -- src/models/model-catalog.service.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: PASS（7 个用例）；typecheck 无输出。

- [ ] **Step 7: 提交**

```bash
git add apps/bff/src/models/model.errors.ts apps/bff/src/models/model-catalog.service.ts \
  apps/bff/src/models/model-catalog.service.test.ts apps/bff/src/models/models.controller.ts \
  apps/bff/src/models/models.module.ts apps/bff/src/app.module.ts
git commit -m "feat(bff): 新增模型目录与客户端模型列表接口

客户端只能看到「全局启用 ∩ 当前套餐」的模型，服务端下发的运行路由
也必须遵循同一规则。目录服务集中处理默认模型回退、套餐过期与厂商
密钥解密，为后续会话选模和运行下发提供唯一入口。"
```

---

## Task 5：会话选定模型与任务运行路由接入

**Files:**
- Modify: `apps/bff/src/sessions/sessions.service.ts`
- Modify: `apps/bff/src/sessions/sessions.service.test.ts`
- Modify: `apps/bff/src/tasks/tasks.service.ts`
- Modify: `apps/bff/src/tasks/tasks.controller.ts`
- Modify: `apps/bff/src/tasks/tasks.controller.test.ts`

- [ ] **Step 1: 更新会话服务测试（先失败）**

修改 `apps/bff/src/sessions/sessions.service.test.ts` 为：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { ModelUnavailableError } from '../models/model.errors';
import type { ModelCatalogService } from '../models/model-catalog.service';
import type { PrismaService } from '../db/prisma.service';

const all = [
  { id: 's1', tenantId: 't1', userId: 'u1', title: 'active', status: 'active', model: 'm1', createdAt: new Date() },
  { id: 's2', tenantId: 't1', userId: 'u1', title: 'archived', status: 'archived', model: null, createdAt: new Date() },
];

function makeService(models = ['m1', 'm2'], defaultModel: string | null = 'm1') {
  const created: { model?: string }[] = [];
  const prisma = {
    session: {
      findMany: async ({ where }: { where: { tenantId: string; userId: string; status?: { not: string } } }) =>
        all.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            (!where.status?.not || s.status !== where.status.not),
        ),
      findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string; status?: { not: string } } }) =>
        all.find(
          (s) =>
            s.id === where.id &&
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            (!where.status?.not || s.status !== where.status.not),
        ) ?? null,
      create: async ({ data }: { data: { tenantId: string; userId: string; title: string; model?: string } }) => {
        created.push({ model: data.model });
        return { id: 's3', createdAt: new Date(), ...data };
      },
    },
  } as unknown as PrismaService;
  const catalog = {
    available: async () => ({
      models: models.map((model) => ({
        model,
        displayName: model,
        providerName: 'p',
        sortOrder: 0,
        source: { kind: 'mock' as const },
      })),
      defaultModel,
    }),
  } as unknown as ModelCatalogService;
  return { svc: new SessionsService(prisma, catalog), created };
}

describe('SessionsService 归档语义', () => {
  it('list 不返回归档会话，并带出会话模型', async () => {
    const list = await makeService().svc.list('t1', 'u1');
    expect(list.map((s) => s.id)).toEqual(['s1']);
    expect(list[0].model).toBe('m1');
  });

  it('归档会话对普通用户视为不存在', async () => {
    await expect(makeService().svc.assertOwned('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SessionsService 选模', () => {
  it('未指定模型时使用默认模型并落库', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', {});
    expect(s.model).toBe('m1');
    expect(created).toEqual([{ model: 'm1' }]);
  });

  it('指定模型必须在可用列表内', async () => {
    const { svc, created } = makeService();
    await expect(svc.create('t1', 'u1', { model: 'gone' })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(created).toEqual([]);
  });

  it('指定可用模型时原样落库', async () => {
    const { svc, created } = makeService();
    const s = await svc.create('t1', 'u1', { model: 'm2' });
    expect(s.model).toBe('m2');
    expect(created).toEqual([{ model: 'm2' }]);
  });

  it('assertOwned 返回会话模型供运行时解析', async () => {
    const ref = await makeService().svc.assertOwned('s1', 't1', 'u1');
    expect(ref).toEqual({ id: 's1', model: 'm1' });
  });
});
```

Run: `pnpm --filter @ai-office/bff test -- src/sessions/sessions.service.test.ts`

Expected: FAIL，`SessionsService` 构造参数不匹配 / `assertOwned` 返回值断言失败。

- [ ] **Step 2: 修改会话服务**

把 `apps/bff/src/sessions/sessions.service.ts` 整体替换为：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { ModelCatalogService } from '../models/model-catalog.service';
import { ModelUnavailableError, NoModelsAvailableError } from '../models/model.errors';
import type {
  CreateSessionRequest,
  MessageDto,
  SessionSummary,
} from '@ai-office/shared';

export interface SessionRef {
  id: string;
  model: string | null;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ModelCatalogService,
  ) {}

  async list(tenantId: string, userId: string): Promise<SessionSummary[]> {
    // 归档会话对普通用户不可见。
    const rows = await this.prisma.session.findMany({
      where: { tenantId, userId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      model: s.model ?? null,
    }));
  }

  async create(
    tenantId: string,
    userId: string,
    req: CreateSessionRequest,
  ): Promise<SessionSummary> {
    const { models, defaultModel } = await this.catalog.available(tenantId);
    if (models.length === 0) throw new NoModelsAvailableError();
    const requested = typeof req.model === 'string' ? req.model.trim() : '';
    let model = defaultModel ?? models[0].model;
    if (requested) {
      if (!models.some((m) => m.model === requested)) throw new ModelUnavailableError();
      model = requested;
    }
    const s = await this.prisma.session.create({
      data: { tenantId, userId, title: req.title ?? '新会话', model },
    });
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      model: s.model ?? null,
    };
  }

  /**
   * 校验会话归属（tenant 强制行级隔离）：非本租户/用户或已归档一律 404，不泄露存在性。
   * 返回 id 与创建时选定的模型，供任务控制器解析运行路由。
   */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<SessionRef> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: { not: 'archived' } },
    });
    if (!s) throw new NotFoundException('session_not_found');
    return { id: s.id, model: s.model ?? null };
  }

  async messages(sessionId: string, tenantId: string, userId: string): Promise<MessageDto[]> {
    await this.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      role: m.role as MessageDto['role'],
      content: m.content,
      seq: m.seq,
    }));
  }
}
```

- [ ] **Step 3: 运行会话测试**

Run: `pnpm --filter @ai-office/bff test -- src/sessions/sessions.service.test.ts`

Expected: PASS（7 个用例）。

- [ ] **Step 4: 修改任务服务**

在 `apps/bff/src/tasks/tasks.service.ts` 中：

```ts
  /** 只为归属校验：让控制器能在计费预占之前先做 404 判断，并拿到会话选定的模型。 */
  async assertOwned(
    sessionId: string,
    tenantId: string,
    userId: string,
  ): Promise<{ id: string; model: string | null }> {
    return this.sessions.assertOwned(sessionId, tenantId, userId);
  }
```

在 `prepare` 方法之后增加：

```ts
  /**
   * 回填历史会话的模型：只写 model 仍为空的行，首次运行成功后生效，
   * 之后即使用户切换默认模型也不会改写已有会话。
   */
  async bindModel(sessionId: string, model: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, model: null },
      data: { model },
    });
  }
```

`prepare` 内的 `await this.sessions.assertOwned(...)` 返回值可忽略，无需改动。

- [ ] **Step 5: 更新任务控制器测试装配（先失败）**

修改 `apps/bff/src/tasks/tasks.controller.test.ts`：

1. 导入区增加：

```ts
import { ModelCatalogService } from '../models/model-catalog.service';
import { ModelUnavailableError } from '../models/model.errors';
```

2. `session` 常量增加模型：

```ts
const session = { id: 's1', tenantId: 't1', userId: 'u1', title: 'x', model: 'mock', createdAt: new Date() };
```

3. 在 `billingCalls` 附近增加（`available` 供 `SessionsService.create` 使用；本文件虽未直接建会话，但服务装配要求完整）：

```ts
const catalogCalls: unknown[][] = [];
let resolveForRunError: unknown = null;
const fakeCatalog = {
  available: async () => ({
    models: [
      {
        model: 'mock',
        displayName: 'mock',
        providerName: '环境变量',
        sortOrder: 0,
        source: { kind: 'mock' as const },
      },
    ],
    defaultModel: 'mock',
  }),
  resolveForRun: async (tenantId: string, model: string | null) => {
    catalogCalls.push([tenantId, model]);
    if (resolveForRunError) throw resolveForRunError;
    return { selectedModel: 'mock', modelRoutes: [] };
  },
} as unknown as ModelCatalogService;
```

4. `fakePrisma.session` 增加回填落库（保留原有 `findFirst`，在其后加 `updateMany`）：

```ts
  session: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      where.id === session.id && where.tenantId === session.tenantId && where.userId === session.userId
        ? session
        : null,
    updateMany: async (args: { where: { id: string; model: null }; data: { model: string } }) => {
      stored.sessionModelUpdates.push(args);
      return { count: 1 };
    },
  },
```

5. `stored` 增加数组：

```ts
const stored: {
  steps: unknown[];
  messages: unknown[];
  runCreates: unknown[];
  runUpdates: unknown[];
  taskUpdates: unknown[];
  artifacts: unknown[];
  sessionModelUpdates: unknown[];
} = {
  steps: [],
  messages: [],
  runCreates: [],
  runUpdates: [],
  taskUpdates: [],
  artifacts: [],
  sessionModelUpdates: [],
};
```

6. 测试模块 providers 增加：

```ts
      { provide: ModelCatalogService, useValue: fakeCatalog },
```

7. `beforeEach` 增加：

```ts
  stored.sessionModelUpdates.length = 0;
  catalogCalls.length = 0;
  resolveForRunError = null;
  session.model = 'mock';
```

> `session` 已是 `const` 对象，修改其 `model` 属性是允许的，用于模拟历史会话。

8. 在已有「把 JWT 的 sub 作为 userId 透传给 runtime」用例中追加断言：

```ts
    const body = JSON.parse(lastRunsBody);
    expect(body.billing.selectedModel).toBe('mock');
    expect(body.modelRoutes).toBeUndefined();
```

9. 新增用例（放在同一 `describe('TasksController')` 内）：

```ts
  it('模型解析失败时不预占、不建 task，并返回明确状态码', async () => {
    resolveForRunError = new ModelUnavailableError();
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ error: 'model_unavailable' });
    expect(billingCalls).toEqual([]);
    expect(stored.runCreates).toHaveLength(0);
  });

  it('历史会话首次运行成功后回填模型', async () => {
    session.model = null;
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: 'g' }),
    });
    await res.text();
    expect(stored.sessionModelUpdates).toEqual([
      { where: { id: 's1', model: null }, data: { model: 'mock' } },
    ]);
  });
```

Run: `pnpm --filter @ai-office/bff test -- src/tasks/tasks.controller.test.ts`

Expected: FAIL，`TasksController` 尚未注入模型目录，且未发送 `selectedModel`。

- [ ] **Step 6: 修改任务控制器**

在 `apps/bff/src/tasks/tasks.controller.ts` 中：

1. 导入区把 `@nestjs/common` 一行改为（新增 `HttpException`）：

```ts
import { Body, Controller, HttpException, Inject, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
```

并增加：

```ts
import { ModelCatalogService } from '../models/model-catalog.service';
```

2. 构造函数改为：

```ts
  constructor(
    private readonly tasks: TasksService,
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    private readonly catalog: ModelCatalogService,
    @Inject(BFF_METRICS) private readonly metrics: BffMetrics,
  ) {}
```

3. 把现有的：

```ts
    // 归属校验放在预占之前：404 不应留下 hold。
    // 与 prepare 内的归属校验重复一次查询，换取「404 早于预占」。
    await this.tasks.assertOwned(sessionId, user.tenantId, user.sub);

    // 配置读取放在预占之前：读失败不应留下 hold。
    const config = await this.settings.getRunConfig();
```

替换为：

```ts
    // 归属校验放在预占之前：404 不应留下 hold；返回值带出会话选定的模型。
    // 与 prepare 内的归属校验重复一次查询，换取「404 早于预占」。
    const session = await this.tasks.assertOwned(sessionId, user.tenantId, user.sub);

    // 配置读取放在预占之前：读失败不应留下 hold。
    const config = await this.settings.getRunConfig();

    // 模型解析同样前置：套餐过期/模型停用/密钥不可用都不应留下 hold。
    let resolution: Awaited<ReturnType<ModelCatalogService['resolveForRun']>>;
    try {
      resolution = await this.catalog.resolveForRun(user.tenantId, session.model);
    } catch (err) {
      if (err instanceof HttpException) {
        reply.status(err.getStatus()).send({ error: err.message });
        return;
      }
      throw err;
    }
```

4. 在 `beginRun` 的 `catch` 块之后（`let prepared:` 之前）插入：

```ts
    // 历史会话在首次成功预占后固化模型；失败只记日志，不影响本次运行。
    if (!session.model) {
      try {
        await this.tasks.bindModel(sessionId, resolution.selectedModel);
      } catch (err) {
        this.logger.warn(`run ${runId} 回填会话模型失败: ${(err as Error).message}`);
      }
    }
    billing = { ...billing, selectedModel: resolution.selectedModel };
```

5. 在 `fetch` 的请求体对象中：

```ts
            billing,
            config,
```

替换为：

```ts
            billing,
            config,
            ...(resolution.modelRoutes.length > 0
              ? { modelRoutes: resolution.modelRoutes }
              : {}),
```

- [ ] **Step 7: 运行任务与会话测试**

Run:

```bash
pnpm --filter @ai-office/bff test -- src/tasks/tasks.controller.test.ts src/sessions/sessions.service.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: PASS；typecheck 无输出。

- [ ] **Step 8: 提交**

```bash
git add apps/bff/src/sessions/sessions.service.ts apps/bff/src/sessions/sessions.service.test.ts \
  apps/bff/src/tasks/tasks.service.ts apps/bff/src/tasks/tasks.controller.ts \
  apps/bff/src/tasks/tasks.controller.test.ts
git commit -m "feat(bff): 按会话模型解析并下发运行路由

新建任务时校验并固化模型，运行时把选中模型与解密的厂商路由一起
交给 runtime；套餐过期、模型停用或密钥不可用都在预占之前失败，
避免留下无人结算的 hold。历史会话在首次运行成功后回填模型。"
```

---

## Task 6：Runtime 按运行构建网关并标注实际模型

**Files:**
- Modify: `apps/agent-runtime/src/model/create-gateway.ts`
- Modify: `apps/agent-runtime/src/model/create-gateway.test.ts`
- Modify: `apps/agent-runtime/src/agent-loop.ts`
- Modify: `apps/agent-runtime/src/agent-loop.test.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Modify: `apps/agent-runtime/src/server.test.ts`

- [ ] **Step 1: 写失败的网关测试**

在 `apps/agent-runtime/src/model/create-gateway.test.ts` 的导入区加入：

```ts
import { createGatewayFromRoutes } from './create-gateway';
import { RoutingGateway } from './routing-gateway';
```

在文件末尾追加：

```ts
describe('createGatewayFromRoutes', () => {
  it('无路由时返回 undefined，保持启动网关', () => {
    expect(createGatewayFromRoutes(undefined)).toBeUndefined();
    expect(createGatewayFromRoutes([])).toBeUndefined();
  });

  it('按路由构建 RoutingGateway，并打到给定 baseUrl', async () => {
    let path = '';
    let auth = '';
    let body: { model?: string } = {};
    const server = createServer((req, res) => {
      path = req.url ?? '';
      auth = String(req.headers.authorization ?? '');
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const gw = createGatewayFromRoutes([
        { model: 'doubao-x', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-1' },
      ]);
      expect(gw).toBeInstanceOf(RoutingGateway);
      const resp = await gw!.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
      expect(path).toBe('/v1/chat/completions');
      expect(auth).toBe('Bearer sk-1');
      expect(body.model).toBe('doubao-x');
      expect(resp.model).toBe('doubao-x');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('字段缺失或模型重复时抛 invalid_model_routes', () => {
    expect(() =>
      createGatewayFromRoutes([{ model: '', baseUrl: 'https://x/v1', apiKey: 'k' }]),
    ).toThrow('invalid_model_routes');
    expect(() =>
      createGatewayFromRoutes([
        { model: 'a', baseUrl: 'https://x/v1', apiKey: 'k' },
        { model: 'a', baseUrl: 'https://y/v1', apiKey: 'k' },
      ]),
    ).toThrow('invalid_model_routes');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- src/model/create-gateway.test.ts`

Expected: FAIL，`createGatewayFromRoutes` 未导出。

- [ ] **Step 3: 实现 `createGatewayFromRoutes`**

在 `apps/agent-runtime/src/model/create-gateway.ts` 顶部增加：

```ts
import type { RunModelRoute } from '@ai-office/shared';
```

在文件末尾追加：

```ts
/**
 * 按 BFF 本次下发的路由构建临时网关；返回 undefined 表示沿用启动网关（Mock/环境变量）。
 * 路由来自内部请求体，属于受信输入，但仍做结构校验，避免配置错误导致静默调用错厂商。
 */
export function createGatewayFromRoutes(
  routes: RunModelRoute[] | undefined,
  observer?: ModelObserver,
): ModelGateway | undefined {
  if (!routes || routes.length === 0) return undefined;
  const seen = new Set<string>();
  const built = routes.map((route) => {
    if (
      !route ||
      typeof route.model !== 'string' ||
      route.model === '' ||
      typeof route.baseUrl !== 'string' ||
      route.baseUrl === '' ||
      typeof route.apiKey !== 'string' ||
      route.apiKey === ''
    ) {
      throw new Error('invalid_model_routes');
    }
    if (seen.has(route.model)) throw new Error('invalid_model_routes');
    seen.add(route.model);
    return {
      model: route.model,
      gateway: new OpenAICompatGateway({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        model: route.model,
      }),
    };
  });
  return new RoutingGateway(built, observer);
}
```

- [ ] **Step 4: 运行网关测试**

Run: `pnpm --filter @ai-office/agent-runtime test -- src/model/create-gateway.test.ts`

Expected: PASS（原有用例 + 新增 3 个）。

- [ ] **Step 5: 写失败的 agent-loop 测试**

在 `apps/agent-runtime/src/agent-loop.test.ts` 末尾追加：

```ts
describe('runAgent 模型选择', () => {
  it('selectedModel 排第一，think 事件带实际模型', async () => {
    let seen: string[] | undefined;
    const gateway: ModelGateway = {
      async chat(req) {
        seen = req.models;
        return { content: '好的', toolCalls: [], usage: { input: 1, output: 1 }, model: req.models?.[0] ?? 'x' };
      },
    };
    const events = await collect(
      runAgent(req, {
        gateway,
        tools: [],
        billing: {
          maxCredits: 10,
          allowedModels: ['a', 'b', 'c'],
          selectedModel: 'b',
          prices: {
            a: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
            b: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
            c: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
          },
        },
      }),
    );
    expect(seen).toEqual(['b', 'a', 'c']);
    expect(events[0].payload).toMatchObject({ text: '好的', model: 'b' });
  });

  it('没有 selectedModel 时保持 allowedModels 原顺序', async () => {
    let seen: string[] | undefined;
    const gateway: ModelGateway = {
      async chat(req) {
        seen = req.models;
        return { content: 'ok', toolCalls: [], usage: { input: 1, output: 1 }, model: 'a' };
      },
    };
    await collect(
      runAgent(req, {
        gateway,
        tools: [],
        billing: {
          maxCredits: 10,
          allowedModels: ['a', 'b'],
          prices: {
            a: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
            b: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
          },
        },
      }),
    );
    expect(seen).toEqual(['a', 'b']);
  });
});
```

Run: `pnpm --filter @ai-office/agent-runtime test -- src/agent-loop.test.ts`

Expected: FAIL，think payload 没有 `model`，且 `selectedModel` 未排序。

- [ ] **Step 6: 修改 agent-loop**

在 `apps/agent-runtime/src/agent-loop.ts` 的 `for` 循环**内**、`const resp = await deps.gateway.chat({` 之前增加（放在函数级也可编译，但放在循环内更贴近调用点）：

```ts
      // 用户选中的模型优先；其余候选按运营端排序，供 429/5xx 时自动回退。
      const selected = deps.billing?.selectedModel;
      const allowed = deps.billing?.allowedModels;
      const models = selected
        ? [selected, ...(allowed ?? []).filter((m) => m !== selected)]
        : allowed;
```

把 `gateway.chat` 调用改为：

```ts
      const resp = await deps.gateway.chat({
        messages,
        tools: schemas,
        models,
      });
```

把 think 事件改为：

```ts
        yield step('think', { text: resp.content, model: resp.model });
```

- [ ] **Step 7: 运行 agent-loop 测试**

Run: `pnpm --filter @ai-office/agent-runtime test -- src/agent-loop.test.ts`

Expected: PASS（含新增 2 个用例）。

- [ ] **Step 8: 让 server 按运行使用下发路由**

修改 `apps/agent-runtime/src/server.ts`：

1. 导入区把创建网关的导入改为：

```ts
import { createGateway, createGatewayFromRoutes } from './model/create-gateway';
```

2. 在 `/runs` 的异步运行回调里，`runTools` 计算之后增加：

```ts
                  // 本次运行优先使用 BFF 下发的厂商路由；缺省沿用启动网关。
                  const runGateway =
                    createGatewayFromRoutes(runReq.modelRoutes, observer) ?? gateway;
```

3. 把 `runAgent` 的 `gateway` 改为 `runGateway`：

```ts
                    gateway: runGateway,
```

- [ ] **Step 9: 写并运行 server 路由测试**

在 `apps/agent-runtime/src/server.test.ts` 末尾追加：

```ts
describe('run 级模型路由', () => {
  it('请求体带 modelRoutes 时覆盖启动网关', async () => {
    let seenModel = '';
    const modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seenModel = (JSON.parse(raw || '{}') as { model?: string }).model ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '来自下发路由' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => modelServer.listen(0, r));
    const addr = modelServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const res = await postRuns({
        runId: 'r-route',
        sessionId: 's1',
        tenantId: 't1',
        userId: 'u1',
        goal: 'g',
        messages: [{ role: 'user', content: 'g' }],
        modelRoutes: [
          { model: 'doubao-x', baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'sk' },
        ],
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain('来自下发路由');
      expect(seenModel).toBe('doubao-x');
    } finally {
      await new Promise<void>((r) => modelServer.close(() => r()));
    }
  });
});
```

在文件顶部导入区增加：

```ts
import { createServer } from 'node:http';
```

Run: `pnpm --filter @ai-office/agent-runtime test -- src/server.test.ts`

Expected: PASS（原有用例 + 新用例）。

- [ ] **Step 10: 类型检查并提交**

Run: `pnpm --filter @ai-office/agent-runtime typecheck`

Expected: 无输出。

```bash
git add apps/agent-runtime/src/model/create-gateway.ts apps/agent-runtime/src/model/create-gateway.test.ts \
  apps/agent-runtime/src/agent-loop.ts apps/agent-runtime/src/agent-loop.test.ts \
  apps/agent-runtime/src/server.ts apps/agent-runtime/src/server.test.ts
git commit -m "feat(runtime): 按运行注入厂商路由并标注实际模型

runtime 不持有数据库与运营配置，BFF 每次运行下发解密后的路由，
由 runtime 临时构建网关并复用既有 429/5xx 回退。把选中模型排到
候选首位，并在 think 事件标注实际应答模型，供客户端识别自动切换。"
```

---

## Task 7：Web 端模型选择与草稿式新建任务

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `packages/web-core/src/errors.ts`
- Modify: `packages/web-core/src/errors.test.ts`（若不存在则新建）
- Modify: `packages/web-core/src/globals.css`

- [ ] **Step 1: 写失败的 API 测试**

在 `apps/web/src/lib/api.test.ts` 的导入列表中加入 `createSession`、`listModels`，并在末尾追加：

```ts
describe('模型接口', () => {
  it('listModels 拉取当前套餐可用模型', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ models: [{ model: 'm1', displayName: '模型一', providerName: '豆包' }], defaultModel: 'm1' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await listModels();
    expect(out.defaultModel).toBe('m1');
    expect(out.models[0].displayName).toBe('模型一');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/models');
  });

  it('createSession 带模型时写入请求体，不带时发送空对象', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 's1', title: '新会话', createdAt: '2026-01-01T00:00:00Z', model: 'm1' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createSession('m1');
    await createSession();
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ model: 'm1' });
    expect(JSON.parse(String(calls[1][1].body))).toEqual({});
  });
});
```

Run: `pnpm --filter @ai-office/web test -- src/lib/api.test.ts`

Expected: FAIL，`listModels`/`createSession` 参数不匹配或未导出。

- [ ] **Step 2: 修改客户端 API**

在 `apps/web/src/lib/api.ts` 的 shared 导入中增加 `ClientModelsDto`：

```ts
import type {
  ArtifactDto,
  BillingSummaryDto,
  ClientModelsDto,
  ConnectorDto,
  CreditLedgerPageDto,
  KbDocDto,
  PlanDto,
  SessionSummary,
  UsageAggregateDto,
} from '@ai-office/shared';
```

把 `createSession` 替换为：

```ts
export async function createSession(model?: string): Promise<SessionSummary> {
  const res = await authFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(model ? { model } : {}),
  });
  if (!res.ok) throw new Error(`create_session_failed_${res.status}`);
  return (await res.json()) as SessionSummary;
}

export async function listModels(): Promise<ClientModelsDto> {
  const res = await authFetch('/api/models');
  if (!res.ok) throw new Error(`models_failed_${res.status}`);
  return (await res.json()) as ClientModelsDto;
}
```

- [ ] **Step 3: 运行 API 测试**

Run: `pnpm --filter @ai-office/web test -- src/lib/api.test.ts`

Expected: PASS。

- [ ] **Step 4: 补 402 文案**

修改 `packages/web-core/src/errors.ts`，在 `status === '401'` 判断**之前**增加（必须早于 `status.startsWith('4')` 的兜底分支）：

```ts
    if (status === '402') return '套餐已到期或积分不足，请前往「套餐与用量」查看';
```

新建或修改 `packages/web-core/src/errors.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { errorText } from './errors';

describe('errorText', () => {
  it('402 引导用户查看套餐', () => {
    expect(errorText(new Error('models_failed_402'))).toBe(
      '套餐已到期或积分不足，请前往「套餐与用量」查看',
    );
  });

  it('409 仍为通用输入提示', () => {
    expect(errorText(new Error('stream_failed_409: model_unavailable'))).toBe(
      '请求无效，请检查输入后重试',
    );
  });
});
```

Run: `pnpm --filter @ai-office/web-core test -- src/errors.test.ts`

Expected: PASS。

- [ ] **Step 5: 修改工作台状态与新建/发送流程**

在 `apps/web/src/app/page.tsx` 中：

1. 类型导入改为：

```ts
import type { AgentEvent, ArtifactDto, ClientModelDto, SessionSummary } from '@ai-office/shared';
```

`../lib/api` 的导入列表增加 `listModels`（`createSession`、`isUnauthorized` 已在列表中）。

2. `EventRow` 增加 `expectedModel` 参数：

```tsx
function EventRow({
  ev,
  expectedModel,
  onOpenArtifacts,
}: {
  ev: AgentEvent;
  expectedModel: string;
  onOpenArtifacts: () => void;
}) {
```

3. 把 `EventRow` 中现有的：

```tsx
  if (ev.type === 'think') {
    meta = '思考';
    iconCls = 'think';
    icon = <IconSpark size={15} />;
  } else if (ev.type === 'tool_call') {
```

替换为：

```tsx
  if (ev.type === 'think') {
    const actual = typeof ev.payload.model === 'string' ? ev.payload.model : '';
    meta = actual
      ? expectedModel && actual !== expectedModel
        ? `思考 · ${actual}（已自动切换）`
        : `思考 · ${actual}`
      : '思考';
    iconCls = 'think';
    icon = <IconSpark size={15} />;
  } else if (ev.type === 'tool_call') {
```

4. `Home` 组件状态增加（放在 `drawerOpen` 之后）：

```tsx
  const [models, setModels] = useState<ClientModelDto[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  // 运营端默认模型：历史会话（model 为空）首次运行前展示的就是它。
  const [defaultModel, setDefaultModel] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
```

5. 首次加载 effect 改为：

```tsx
  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
    void refreshModels();
  }, [router]);
```

6. 在 `refresh()` 之前增加 `refreshModels`：

```tsx
  async function refreshModels() {
    try {
      const data = await listModels();
      setModels(data.models);
      const fallback = data.defaultModel ?? data.models[0]?.model ?? '';
      setDefaultModel(fallback);
      setSelectedModel((prev) => {
        if (prev && data.models.some((m) => m.model === prev)) return prev;
        return fallback;
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      setModelsLoaded(true);
    }
  }
```

7. `refresh()` 中把：

```ts
      setSessions(list);
      if (list.length) setSessionId(list[0].id);
```

改为：

```ts
      setSessions(list);
      if (list.length) {
        setSessionId(list[0].id);
        if (list[0].model) setSelectedModel(list[0].model);
      }
```

8. 删除整个 `newSession()` 函数，把 `handleNewSession` 改为同步草稿态：

```tsx
  function handleNewSession() {
    if (running) return;
    // 新任务先清成草稿：真正建会话推迟到首次发送，才能把用户选的模型写进会话。
    setSessionId('');
    resetConversation();
    void refreshModels();
    composerRef.current?.focus();
  }
```

9. `handleSelect` 同步会话模型：

```tsx
  function handleSelect(id: string) {
    if (running || id === sessionId) return;
    const target = sessions.find((s) => s.id === id);
    // 历史会话没有固化的模型：展示当前默认模型，实际运行由服务端按默认值解析。
    setSelectedModel(target?.model ?? defaultModel);
    setSessionId(id);
    resetConversation();
  }
```

10. `run()` 中把：

```ts
      // sessionId 为 state，newSession 的 setSessionId 不会同步更新本次渲染闭包里的值，
      // 故必须用 newSession 返回的 id 直接发起请求，否则会 POST 到空 id 的会话。
      if (!sid) sid = (await newSession()).id;
      const res = await streamTask(sid, currentGoal);
```

替换为：

```ts
      // 草稿态首次发送才建会话，并把选中的模型固化到会话上。
      // 不能用 setSessionId 后的 state：本次渲染闭包拿不到新值。
      if (!sid) {
        const created = await createSession(selectedModel || undefined);
        setSessions((prev) => [created, ...prev]);
        if (created.model) setSelectedModel(created.model);
        setSessionId(created.id);
        sid = created.id;
      }
      const res = await streamTask(sid, currentGoal);
```

11. 在 `const current = sessions.find((s) => s.id === sessionId);` 之后增加派生值：

```tsx
  // 历史会话没有固化模型时展示运营端默认值（与服务端 resolveForRun 的缺省一致）。
  const modelValue = sessionId ? (current?.model || defaultModel || selectedModel) : selectedModel;
  const modelAvailable =
    !sessionId || models.length === 0 || models.some((m) => m.model === modelValue);
  const canSend = !running && !!goal.trim() && models.length > 0 && modelAvailable;
```

12. 把 `textarea` 的 `onKeyDown` 内：

```tsx
              if (!running && goal.trim()) void run();
```

改为：

```tsx
              if (canSend) void run();
```

并把发送按钮的 `disabled={running || !goal.trim()}` 改为 `disabled={!canSend}`。

13. 在 `.wb-composer` 内、`<textarea>` 之前插入：

```tsx
        <div className="wb-composer-model">
          <select
            className="wb-model-select"
            value={modelValue}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={running || !!sessionId || models.length === 0}
            aria-label="选择模型"
            title={sessionId ? '切换模型请新建任务' : '选择本次任务使用的模型'}
          >
            {!modelAvailable && modelValue && (
              <option value={modelValue}>{modelValue}（已停用）</option>
            )}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName && m.displayName !== m.model
                  ? `${m.displayName} · ${m.model} · ${m.providerName}`
                  : `${m.model} · ${m.providerName}`}
              </option>
            ))}
          </select>
          {sessionId && <span className="wb-model-lock">切换模型请新建任务</span>}
        </div>
        {modelsLoaded && models.length === 0 && (
          <div className="wb-model-empty">当前套餐暂无可用模型，请联系管理员。</div>
        )}
        {!modelAvailable && (
          <div className="wb-model-empty">该会话使用的模型已停用，请新建任务。</div>
        )}
```

14. 把事件渲染改为：

```tsx
                  <EventRow
                    key={ev.seq}
                    ev={ev}
                    expectedModel={modelValue}
                    onOpenArtifacts={() => setDrawerOpen(true)}
                  />
```

- [ ] **Step 6: 增加样式**

在 `packages/web-core/src/globals.css` 的 `.wb-composer textarea` 规则之前增加：

```css
.wb-composer-model {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 8px;
}

.wb-model-select {
  max-width: 100%;
  height: 30px;
  padding: 0 28px 0 10px;
  font-size: 12.5px;
  color: var(--wb-ink-2);
  background: var(--surface-2);
  border: 1px solid var(--wb-line-strong);
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}

.wb-model-select:disabled {
  color: var(--wb-ink-2);
  cursor: not-allowed;
  background: var(--surface-2);
}

.wb-model-lock {
  font-size: 12px;
  color: var(--wb-ink-2);
}

.wb-model-empty {
  padding: 6px 2px;
  font-size: 12px;
  color: var(--amber-ink);
}
```

- [ ] **Step 7: 运行 Web 测试与构建**

Run:

```bash
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web build
```

Expected: 测试全部通过；`next build` 成功。若本地 dev server 正在运行，先停掉再构建，避免 `.next` 目录被并发写坏。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/app/page.tsx \
  packages/web-core/src/errors.ts packages/web-core/src/errors.test.ts packages/web-core/src/globals.css
git commit -m "feat(web): 支持新建任务时选择模型

客户端只展示当前套餐可用的已启用模型，模型在创建任务时固化，
已有会话锁定选择并在输入区提示切换需新建任务。历史会话没有模型
时沿用运营端默认值；实际应答模型与所选不一致时在事件上标注
自动切换，便于用户理解计费与输出来源。"
```

---

## Task 8：运营平台厂商/模型管理后端

**Files:**
- Modify: `packages/shared/src/dto.ts`（替换旧管理端模型 DTO）
- Rewrite: `apps/bff/src/admin/admin-models.service.ts`
- Rewrite: `apps/bff/src/admin/admin-models.controller.ts`
- Rewrite: `apps/bff/src/admin/admin-models.service.test.ts`
- Create: `apps/bff/src/admin/admin-models.controller.test.ts`

- [ ] **Step 1: 替换共享管理端 DTO**

在 `packages/shared/src/dto.ts` 中删除旧的 `AdminModelProviderDto`、`AdminModelPriceDto`、`AdminModelsDto`（以及 Task 3 临时加的 `AdminLegacyProviderDto` 原位保留），替换为：

```ts
/** 运营端厂商（永不返回 apiKey 明文）。 */
export interface AdminModelProviderDto {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string | null;
  modelCount: number;
  createdAt: string;
}

/** 运营端模型目录项。 */
export interface AdminModelDto {
  model: string;
  displayName: string;
  providerId: string | null;
  providerName: string | null;
  enabled: boolean;
  sortOrder: number;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  isDefault: boolean;
  updatedAt: string;
}

/** 环境变量兜底 provider（仅展示分组名与模型名）。 */
export interface AdminLegacyProviderDto {
  name: string;
  models: string[];
}

export interface AdminModelsDto {
  providers: AdminModelProviderDto[];
  models: AdminModelDto[];
  defaultModel: string | null;
  /** active=true 表示数据库没有厂商，运行时使用环境变量兜底。 */
  fallback: { active: boolean; providers: AdminLegacyProviderDto[] };
}

export interface AdminModelTestResultDto {
  ok: boolean;
  latencyMs: number;
  error?: string;
}
```

- [ ] **Step 2: 写失败的管理端服务测试**

把 `apps/bff/src/admin/admin-models.service.test.ts` 整体替换为：

```ts
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminModelsService } from './admin-models.service';
import { encryptSecret, decryptSecret } from '../secrets/secret-box';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };
const KEY = 'd'.repeat(64);

beforeEach(() => {
  process.env.MODEL_ENC_KEY = KEY;
  delete process.env.MODEL_PROVIDERS;
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function p2002() {
  return Object.assign(new Error('unique'), { code: 'P2002' });
}

function p2003() {
  return Object.assign(new Error('fk'), { code: 'P2003' });
}

interface FakeProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnc: string;
  apiKeyHint: string | null;
  createdAt: Date;
}

interface FakeModel {
  model: string;
  providerId: string | null;
  displayName: string | null;
  enabled: boolean;
  sortOrder: number;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  updatedAt: Date;
}

function makeService(opts: { planInUse?: boolean; subInUse?: boolean } = {}) {
  const providers = new Map<string, FakeProvider>();
  providers.set('p1', {
    id: 'p1',
    name: '豆包',
    baseUrl: 'https://ark.example/v3',
    apiKeyEnc: encryptSecret('sk-ark-1234', 'MODEL_ENC_KEY'),
    apiKeyHint: '****1234',
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  const models = new Map<string, FakeModel>();
  models.set('m1', {
    model: 'm1',
    providerId: 'p1',
    displayName: null,
    enabled: true,
    sortOrder: 10,
    inputMilliCreditsPer1k: 100,
    outputMilliCreditsPer1k: 200,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });
  let defaultModel: string | null = 'm1';
  const audits: unknown[] = [];

  const withProvider = (m: FakeModel) => ({
    ...m,
    provider: m.providerId ? (providers.get(m.providerId) ?? null) : null,
  });

  const db = {
    modelProvider: {
      count: async () => providers.size,
      findMany: async () =>
        [...providers.values()].map((p) => ({
          ...p,
          _count: { models: [...models.values()].filter((m) => m.providerId === p.id).length },
        })),
      findUnique: async ({ where }: { where: { id: string } }) => providers.get(where.id) ?? null,
      create: async ({ data }: { data: { name: string; baseUrl: string; apiKeyEnc: string; apiKeyHint: string } }) => {
        if ([...providers.values()].some((p) => p.name === data.name)) throw p2002();
        const row = {
          id: `p${providers.size + 1}`,
          createdAt: new Date('2026-10-20T00:00:00Z'),
          ...data,
        };
        providers.set(row.id, row);
        return { ...row, _count: { models: 0 } };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ name: string; baseUrl: string; apiKeyEnc: string; apiKeyHint: string }> }) => {
        const prev = providers.get(where.id);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        const row = { ...prev, ...data };
        providers.set(where.id, row);
        return {
          ...row,
          _count: { models: [...models.values()].filter((m) => m.providerId === row.id).length },
        };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const prev = providers.get(where.id);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        providers.delete(where.id);
        return prev;
      },
    },
    modelConfig: {
      count: async ({ where }: { where: { providerId: string } }) =>
        [...models.values()].filter((m) => m.providerId === where.providerId).length,
      findMany: async () =>
        [...models.values()]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.model.localeCompare(b.model))
          .map(withProvider),
      findUnique: async ({ where }: { where: { model: string } }) => {
        const row = models.get(where.model);
        return row ? withProvider(row) : null;
      },
      create: async ({
        data,
      }: {
        data: Omit<FakeModel, 'updatedAt'> & { providerId: string };
      }) => {
        if (models.has(data.model)) throw p2002();
        if (!providers.has(data.providerId)) throw p2003();
        const row: FakeModel = { ...data, updatedAt: new Date('2026-10-20T00:00:00Z') };
        models.set(row.model, row);
        return withProvider(row);
      },
      update: async ({
        where,
        data,
      }: {
        where: { model: string };
        data: Partial<Omit<FakeModel, 'model' | 'updatedAt'>>;
      }) => {
        const prev = models.get(where.model);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        if (typeof data.providerId === 'string' && !providers.has(data.providerId)) throw p2003();
        const row = { ...prev, ...data, updatedAt: new Date('2026-10-20T00:00:00Z') };
        models.set(where.model, row);
        return withProvider(row);
      },
      delete: async ({ where }: { where: { model: string } }) => {
        const prev = models.get(where.model);
        if (!prev) throw Object.assign(new Error('missing'), { code: 'P2025' });
        models.delete(where.model);
        return prev;
      },
    },
    plan: {
      findFirst: async () => (opts.planInUse ? { id: 'pro' } : null),
    },
    subscription: {
      findFirst: async () => (opts.subInUse ? { tenantId: 't1' } : null),
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === 'defaultModel' && defaultModel
          ? { key: where.key, value: defaultModel, updatedBy: null, updatedAt: new Date() }
          : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        defaultModel = create.value;
        return { key: where.key, ...create };
      },
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      models.has(values[0] as string) ? [{ model: values[0] }] : [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminModelsService(db, audit), audits, providers, models, getDefault: () => defaultModel };
}

describe('AdminModelsService', () => {
  it('catalog 不返回密钥，并标记默认模型与环境兜底', async () => {
    const { svc } = makeService();
    const out = await svc.catalog();
    expect(out.providers[0]).toMatchObject({ id: 'p1', name: '豆包', apiKeyHint: '****1234', modelCount: 1 });
    expect(out.models[0]).toMatchObject({ model: 'm1', providerName: '豆包', isDefault: true });
    expect(out.defaultModel).toBe('m1');
    expect(out.fallback.active).toBe(false);
    expect(JSON.stringify(out)).not.toContain('sk-ark-1234');
  });

  it('创建厂商时加密且只记录尾号，审计不含密钥', async () => {
    const { svc, audits, providers } = makeService();
    const created = await svc.createProvider(
      { name: '千问', baseUrl: 'https://dash.example/v1/', apiKey: 'sk-qwen-9999' },
      actor,
    );
    expect(created.baseUrl).toBe('https://dash.example/v1');
    expect(created.apiKeyHint).toBe('****9999');
    const row = [...providers.values()].find((p) => p.name === '千问')!;
    expect(row.apiKeyEnc).not.toContain('sk-qwen-9999');
    expect(decryptSecret(row.apiKeyEnc, 'MODEL_ENC_KEY')).toBe('sk-qwen-9999');
    expect(audits[0]).toMatchObject({ action: 'modelProvider.create', targetType: 'modelProvider' });
    expect(JSON.stringify(audits)).not.toContain('sk-qwen-9999');
  });

  it('重复厂商返回 409', async () => {
    const { svc } = makeService();
    await expect(
      svc.createProvider({ name: '豆包', baseUrl: 'https://x/v1', apiKey: 'sk' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('厂商仍有模型时拒绝删除', async () => {
    const { svc } = makeService();
    await expect(svc.removeProvider('p1', actor)).rejects.toMatchObject({
      message: 'provider_has_models',
    });
  });

  it('创建模型校验价格并写审计', async () => {
    const { svc, audits } = makeService();
    const dto = await svc.createModel(
      {
        model: 'm2',
        displayName: '模型二',
        providerId: 'p1',
        enabled: true,
        sortOrder: 20,
        prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 2 },
      },
      actor,
    );
    expect(dto).toMatchObject({ model: 'm2', providerName: '豆包', enabled: true, sortOrder: 20 });
    expect(audits.at(-1)).toMatchObject({ action: 'model.create', targetType: 'modelConfig' });

    await expect(
      svc.createModel(
        {
          model: 'm3',
          providerId: 'p1',
          prices: { inputMilliCreditsPer1k: -1, outputMilliCreditsPer1k: 2 },
        },
        actor,
      ),
    ).rejects.toMatchObject({ message: 'invalid_price' });
  });

  it('重复模型返回 409；厂商不存在返回 404', async () => {
    const { svc } = makeService();
    await expect(
      svc.createModel(
        { model: 'm1', providerId: 'p1', prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 } },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.createModel(
        { model: 'm9', providerId: 'missing', prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 } },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('停用默认模型被拒绝', async () => {
    const { svc } = makeService();
    await expect(svc.updateModel({ model: 'm1', enabled: false }, actor)).rejects.toMatchObject({
      message: 'default_model_in_use',
    });
  });

  it('删除默认模型被拒绝', async () => {
    const { svc } = makeService();
    await expect(svc.removeModel('m1', actor)).rejects.toMatchObject({
      message: 'default_model_in_use',
    });
  });

  it('删除被套餐或有效订阅引用的非默认模型被拒绝', async () => {
    for (const opts of [{ planInUse: true }, { subInUse: true }]) {
      const { svc } = makeService(opts);
      await svc.createModel(
        {
          model: 'm2',
          providerId: 'p1',
          prices: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
        },
        actor,
      );
      await expect(svc.removeModel('m2', actor)).rejects.toMatchObject({
        message: 'model_in_use',
      });
    }
  });

  it('设置默认模型要求模型存在且启用', async () => {
    const { svc, getDefault, audits } = makeService();
    await expect(svc.setDefault({ model: 'missing' }, actor)).rejects.toMatchObject({
      message: 'invalid_default_model',
    });
    await svc.updateModel({ model: 'm1', enabled: true }, actor);
    await svc.setDefault({ model: 'm1' }, actor);
    expect(getDefault()).toBe('m1');
    expect(audits.some((a) => (a as { action: string }).action === 'model.default')).toBe(true);
  });

  it('测试连接成功/失败均返回结果，且错误中的密钥被脱敏', async () => {
    const { svc } = makeService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })),
    );
    await expect(svc.testModel({ model: 'm1' }, actor)).resolves.toMatchObject({ ok: true });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad sk-ark-1234', { status: 401 })),
    );
    const failed = await svc.testModel({ model: 'm1' }, actor);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('[REDACTED]');
    expect(failed.error).not.toContain('sk-ark-1234');
  });

  it('不存在的模型抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.updateModel({ model: 'missing', enabled: true }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.testModel({ model: 'missing' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-models.service.test.ts`

Expected: FAIL，旧 `AdminModelsService` 没有这些方法。

- [ ] **Step 3: 实现管理端服务**

把 `apps/bff/src/admin/admin-models.service.ts` 整体替换为：

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminModelDto,
  AdminModelProviderDto,
  AdminModelsDto,
  AdminModelTestResultDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { decryptSecret, encryptSecret } from '../secrets/secret-box';
import { DEFAULT_MODEL_SETTING_KEY, MODEL_ENC_KEY } from '../models/model.constants';
import { listEnvProviderGroups } from '../models/env-providers';

const MAX_INT32 = 2_147_483_647;
const TEST_TIMEOUT_MS = 10_000;

interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string | null;
  createdAt: Date;
  _count: { models: number };
}

interface ModelRow {
  model: string;
  displayName: string | null;
  providerId: string | null;
  enabled: boolean;
  sortOrder: number;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  updatedAt: Date;
  provider: { id: string; name: string } | null;
}

function text(raw: unknown, code: string, maxLength: number): string {
  if (typeof raw !== 'string') throw new BadRequestException(code);
  const value = raw.trim();
  if (value === '' || value.length > maxLength) throw new BadRequestException(code);
  return value;
}

function optionalText(raw: unknown, maxLength: number): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException('invalid_display_name');
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > maxLength) throw new BadRequestException('invalid_display_name');
  return value;
}

function baseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_base_url');
  const value = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new BadRequestException('invalid_base_url');
  }
  return value;
}

function apiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('invalid_api_key');
  const value = raw.trim();
  if (value === '' || value.length > 512) throw new BadRequestException('invalid_api_key');
  return value;
}

function enabled(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new BadRequestException('invalid_enabled');
  return raw;
}

function sortOrder(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > 1_000_000) {
    throw new BadRequestException('invalid_sort_order');
  }
  return raw;
}

function priceInt(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_INT32) {
    throw new BadRequestException('invalid_price');
  }
  return raw;
}

function prices(raw: unknown): {
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
} {
  if (raw === null || typeof raw !== 'object') throw new BadRequestException('invalid_price');
  const p = raw as Record<string, unknown>;
  return {
    inputMilliCreditsPer1k: priceInt(p.inputMilliCreditsPer1k),
    outputMilliCreditsPer1k: priceInt(p.outputMilliCreditsPer1k),
  };
}

function modelName(raw: unknown): string {
  return text(raw, 'invalid_model', 128);
}

function hint(secret: string): string {
  return secret.length >= 4 ? `****${secret.slice(-4)}` : '****';
}

function redact(message: string, secret: string): string {
  const clean = secret ? message.split(secret).join('[REDACTED]') : message;
  return clean.slice(0, 300);
}

function toProviderDto(row: ProviderRow): AdminModelProviderDto {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKeyHint: row.apiKeyHint,
    modelCount: row._count.models,
    createdAt: row.createdAt.toISOString(),
  };
}

function toModelDto(row: ModelRow, defaultModel: string | null): AdminModelDto {
  return {
    model: row.model,
    displayName: row.displayName ?? row.model,
    providerId: row.providerId,
    providerName: row.provider?.name ?? null,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    inputMilliCreditsPer1k: row.inputMilliCreditsPer1k,
    outputMilliCreditsPer1k: row.outputMilliCreditsPer1k,
    isDefault: defaultModel === row.model,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 运营端模型目录：厂商、模型、默认模型与连通性测试；所有写操作与审计同事务。 */
@Injectable()
export class AdminModelsService {
  private readonly logger = new Logger(AdminModelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async catalog(): Promise<AdminModelsDto> {
    const [providers, models, defaultModel] = await Promise.all([
      this.prisma.modelProvider.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { models: true } } },
      }),
      this.prisma.modelConfig.findMany({
        orderBy: [{ sortOrder: 'asc' }, { model: 'asc' }],
        include: { provider: { select: { id: true, name: true } } },
      }),
      this.readDefault(this.prisma),
    ]);
    return {
      providers: providers.map(toProviderDto),
      models: models.map((m) => toModelDto(m, defaultModel)),
      defaultModel,
      fallback: { active: providers.length === 0, providers: listEnvProviderGroups(process.env) },
    };
  }

  async createProvider(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelProviderDto> {
    const name = text(body?.name, 'invalid_provider_name', 64);
    const url = baseUrl(body?.baseUrl);
    const plain = apiKey(body?.apiKey);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelProvider.create({
          data: {
            name,
            baseUrl: url,
            apiKeyEnc: encryptSecret(plain, MODEL_ENC_KEY),
            apiKeyHint: hint(plain),
          },
          include: { _count: { select: { models: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'modelProvider.create',
          targetType: 'modelProvider',
          targetId: created.id,
          summary: { name },
        });
        return created;
      });
      return toProviderDto(row);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('provider_exists');
      }
      throw err;
    }
  }

  async updateProvider(
    id: string,
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelProviderDto> {
    const providerId = text(id, 'invalid_provider_id', 64);
    const data: { name?: string; baseUrl?: string; apiKeyEnc?: string; apiKeyHint?: string } = {};
    if (body?.name !== undefined) data.name = text(body.name, 'invalid_provider_name', 64);
    if (body?.baseUrl !== undefined) data.baseUrl = baseUrl(body.baseUrl);
    if (body?.apiKey !== undefined) {
      const plain = apiKey(body.apiKey);
      data.apiKeyEnc = encryptSecret(plain, MODEL_ENC_KEY);
      data.apiKeyHint = hint(plain);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_provider_patch');

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelProvider.findUnique({ where: { id: providerId } });
        if (!before) throw new NotFoundException('provider_not_found');
        const updated = await tx.modelProvider.update({
          where: { id: providerId },
          data,
          include: { _count: { select: { models: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'modelProvider.update',
          targetType: 'modelProvider',
          targetId: providerId,
          summary: {
            before: { name: before.name, baseUrl: before.baseUrl },
            after: { name: updated.name, baseUrl: updated.baseUrl },
          },
        });
        return updated;
      });
      return toProviderDto(row);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictException('provider_exists');
      if (code === 'P2025') throw new NotFoundException('provider_not_found');
      throw err;
    }
  }

  async removeProvider(id: string, actor: AdminActor): Promise<void> {
    const providerId = text(id, 'invalid_provider_id', 64);
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelProvider.findUnique({ where: { id: providerId } });
        if (!before) throw new NotFoundException('provider_not_found');
        const count = await tx.modelConfig.count({ where: { providerId } });
        if (count > 0) throw new BadRequestException('provider_has_models');
        await tx.modelProvider.delete({ where: { id: providerId } });
        await this.audit.write(tx, actor, {
          action: 'modelProvider.delete',
          targetType: 'modelProvider',
          targetId: providerId,
          summary: { name: before.name },
        });
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') throw new NotFoundException('provider_not_found');
      if (code === 'P2003') throw new BadRequestException('provider_has_models');
      throw err;
    }
  }

  async createModel(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelDto> {
    const model = modelName(body?.model);
    const providerId = text(body?.providerId, 'provider_required', 64);
    const displayName = optionalText(body?.displayName, 128);
    const isEnabled = body?.enabled === undefined ? false : enabled(body.enabled);
    const order = body?.sortOrder === undefined ? 0 : sortOrder(body.sortOrder);
    const price = prices(body?.prices);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.modelConfig.create({
          data: {
            model,
            providerId,
            displayName,
            enabled: isEnabled,
            sortOrder: order,
            ...price,
          },
          include: { provider: { select: { id: true, name: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'model.create',
          targetType: 'modelConfig',
          targetId: model,
          summary: { providerId, enabled: isEnabled, ...price },
        });
        return created;
      });
      return toModelDto(row, await this.readDefault(this.prisma));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictException('model_exists');
      if (code === 'P2003') throw new NotFoundException('provider_not_found');
      throw err;
    }
  }

  async updateModel(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelDto> {
    const model = modelName(body?.model);
    const data: {
      displayName?: string | null;
      providerId?: string;
      enabled?: boolean;
      sortOrder?: number;
      inputMilliCreditsPer1k?: number;
      outputMilliCreditsPer1k?: number;
    } = {};
    if (body?.displayName !== undefined) data.displayName = optionalText(body.displayName, 128);
    if (body?.providerId !== undefined) {
      data.providerId = text(body.providerId, 'provider_required', 64);
    }
    if (body?.enabled !== undefined) data.enabled = enabled(body.enabled);
    if (body?.sortOrder !== undefined) data.sortOrder = sortOrder(body.sortOrder);
    if (body?.prices !== undefined) Object.assign(data, prices(body.prices));
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_model_patch');

    const defaultModel = await this.readDefault(this.prisma);
    if (data.enabled === false && defaultModel === model) {
      throw new BadRequestException('default_model_in_use');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const before = await tx.modelConfig.findUnique({ where: { model } });
        if (!before) throw new NotFoundException('model_not_found');
        const updated = await tx.modelConfig.update({
          where: { model },
          data,
          include: { provider: { select: { id: true, name: true } } },
        });
        await this.audit.write(tx, actor, {
          action: 'model.update',
          targetType: 'modelConfig',
          targetId: model,
          summary: {
            before: {
              displayName: before.displayName,
              providerId: before.providerId,
              enabled: before.enabled,
              sortOrder: before.sortOrder,
              input: before.inputMilliCreditsPer1k,
              output: before.outputMilliCreditsPer1k,
            },
            after: {
              displayName: updated.displayName,
              providerId: updated.providerId,
              enabled: updated.enabled,
              sortOrder: updated.sortOrder,
              input: updated.inputMilliCreditsPer1k,
              output: updated.outputMilliCreditsPer1k,
            },
          },
        });
        return updated;
      });
      return toModelDto(row, defaultModel);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') throw new NotFoundException('model_not_found');
      if (code === 'P2003') throw new NotFoundException('provider_not_found');
      throw err;
    }
  }

  async removeModel(model: string, actor: AdminActor): Promise<void> {
    const name = modelName(model);
    try {
      await this.prisma.$transaction(async (tx) => {
        // 锁住价格行，避免套餐在引用校验与删除之间插入。
        const locked = await tx.$queryRaw<Array<{ model: string }>>`
          SELECT "model" FROM "ModelPrice" WHERE "model" = ${name} FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundException('model_not_found');

        const defaultModel = await this.readDefault(tx);
        if (defaultModel === name) throw new BadRequestException('default_model_in_use');

        const used = await tx.plan.findFirst({
          where: { active: true, allowedModels: { has: name } },
          select: { id: true },
        });
        if (used) throw new BadRequestException('model_in_use');

        // 停用套餐的有效订阅仍可使用到期，同样不能删。
        const subscribed = await tx.subscription.findFirst({
          where: { periodEnd: { gt: new Date() }, plan: { allowedModels: { has: name } } },
          select: { tenantId: true },
        });
        if (subscribed) throw new BadRequestException('model_in_use');

        await tx.modelConfig.delete({ where: { model: name } });
        await this.audit.write(tx, actor, {
          action: 'model.delete',
          targetType: 'modelConfig',
          targetId: name,
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('model_not_found');
      }
      throw err;
    }
  }

  async setDefault(body: Record<string, unknown>, actor: AdminActor): Promise<AdminModelsDto> {
    const model = modelName(body?.model);
    const row = await this.prisma.modelConfig.findUnique({ where: { model } });
    if (!row || !row.enabled) throw new BadRequestException('invalid_default_model');
    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: DEFAULT_MODEL_SETTING_KEY },
        create: { key: DEFAULT_MODEL_SETTING_KEY, value: model, updatedBy: actor.id },
        update: { value: model, updatedBy: actor.id },
      });
      await this.audit.write(tx, actor, {
        action: 'model.default',
        targetType: 'modelConfig',
        targetId: model,
      });
    });
    return this.catalog();
  }

  /**
   * 测试连接：只发一次最小补全请求，失败也返回 200 结果体。
   * 上游错误可能回显请求头，返回前必须把 Key 替换掉并截断。
   */
  async testModel(
    body: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminModelTestResultDto> {
    const model = modelName(body?.model);
    const row = await this.prisma.modelConfig.findUnique({
      where: { model },
      include: { provider: true },
    });
    if (!row || !row.provider) throw new NotFoundException('model_not_found');

    let key: string;
    try {
      key = decryptSecret(row.provider.apiKeyEnc, MODEL_ENC_KEY);
    } catch {
      this.logger.error(`模型 ${model} 的厂商密钥无法解密`);
      throw new ServiceUnavailableException('model_provider_unavailable');
    }

    const started = Date.now();
    let ok = false;
    let error: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(`${row.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        error = redact(`HTTP ${res.status} ${text}`.trim(), key);
      } else {
        await res.body?.cancel().catch(() => undefined);
        ok = true;
      }
    } catch (err) {
      const name = (err as Error).name;
      error = redact(name === 'AbortError' ? 'timeout' : (err as Error).message, key);
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    await this.audit.bestEffort(actor, {
      action: 'model.test',
      targetType: 'modelConfig',
      targetId: model,
      summary: { ok, latencyMs },
    });
    return { ok, latencyMs, ...(error ? { error } : {}) };
  }

  private async readDefault(
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await client.setting.findUnique({
      where: { key: DEFAULT_MODEL_SETTING_KEY },
    });
    return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
  }
}
```

- [ ] **Step 4: 重写管理端控制器**

把 `apps/bff/src/admin/admin-models.controller.ts` 整体替换为：

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminModelDto,
  AdminModelProviderDto,
  AdminModelsDto,
  AdminModelTestResultDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminModelsService } from './admin-models.service';

/**
 * 管理端模型接口。模型名可能包含 `/`，因此更新/删除使用请求体/查询参数，
 * 不把模型名放进路径，避免编码差异导致路由不匹配。
 */
@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminModelsController {
  constructor(private readonly models: AdminModelsService) {}

  @Get('models')
  catalog(): Promise<AdminModelsDto> {
    return this.models.catalog();
  }

  @Post('model-providers')
  createProvider(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelProviderDto> {
    return this.models.createProvider(body ?? {}, actorOf(user, req));
  }

  @Patch('model-providers/:id')
  updateProvider(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelProviderDto> {
    return this.models.updateProvider(id, body ?? {}, actorOf(user, req));
  }

  @Delete('model-providers/:id')
  @HttpCode(204)
  async removeProvider(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.models.removeProvider(id, actorOf(user, req));
  }

  @Post('models')
  createModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelDto> {
    return this.models.createModel(body ?? {}, actorOf(user, req));
  }

  @Patch('models')
  updateModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelDto> {
    return this.models.updateModel(body ?? {}, actorOf(user, req));
  }

  @Delete('models')
  @HttpCode(204)
  async removeModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Query('model') model: string,
  ): Promise<void> {
    await this.models.removeModel(model, actorOf(user, req));
  }

  @Post('models/test')
  testModel(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelTestResultDto> {
    return this.models.testModel(body ?? {}, actorOf(user, req));
  }

  @Put('default-model')
  setDefault(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelsDto> {
    return this.models.setDefault(body ?? {}, actorOf(user, req));
  }
}
```

- [ ] **Step 5: 写控制器路由测试**

创建 `apps/bff/src/admin/admin-models.controller.test.ts`：

```ts
import 'reflect-metadata';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminModelsController } from './admin-models.controller';
import { AdminModelsService } from './admin-models.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const calls: unknown[][] = [];
const fakeService = {
  catalog: async () => ({ providers: [], models: [], defaultModel: null, fallback: { active: true, providers: [] } }),
  createProvider: async (...args: unknown[]) => {
    calls.push(['createProvider', ...args]);
    return { id: 'p1' };
  },
  updateProvider: async (...args: unknown[]) => {
    calls.push(['updateProvider', ...args]);
    return { id: 'p1' };
  },
  removeProvider: async (...args: unknown[]) => {
    calls.push(['removeProvider', ...args]);
  },
  createModel: async (...args: unknown[]) => {
    calls.push(['createModel', ...args]);
    return { model: 'm1' };
  },
  updateModel: async (...args: unknown[]) => {
    calls.push(['updateModel', ...args]);
    return { model: 'm/1' };
  },
  removeModel: async (...args: unknown[]) => {
    calls.push(['removeModel', ...args]);
  },
  testModel: async (...args: unknown[]) => {
    calls.push(['testModel', ...args]);
    return { ok: true, latencyMs: 1 };
  },
  setDefault: async (...args: unknown[]) => {
    calls.push(['setDefault', ...args]);
    return { providers: [], models: [], defaultModel: 'm1', fallback: { active: false, providers: [] } };
  },
} as unknown as AdminModelsService;

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'admin' ? 'admin' : 'member',
      tenantId: 't1',
      email: `${where.id}@test.local`,
    }),
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;
const auth = (sub: string) => ({ authorization: `Bearer ${signToken({ sub, tenantId: 't1' })}` });

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminModelsController],
    providers: [
      { provide: AdminModelsService, useValue: fakeService },
      { provide: PrismaService, useValue: fakePrisma },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('AdminModelsController', () => {
  it('未登录 401，普通成员 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/models' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/models', headers: auth('u1') })).statusCode,
    ).toBe(403);
  });

  it('模型更新与删除走请求体/查询参数', async () => {
    calls.length = 0;
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/admin/models',
      headers: auth('admin'),
      payload: { model: 'm/1', enabled: true },
    });
    expect(patch.statusCode).toBe(200);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/admin/models?model=m%2F1',
      headers: auth('admin'),
    });
    expect(del.statusCode).toBe(204);
    expect(calls[0][0]).toBe('updateModel');
    expect(calls[0][1]).toEqual({ model: 'm/1', enabled: true });
    expect(calls[1][0]).toBe('removeModel');
    expect(calls[1][1]).toBe('m/1');
  });

  it('厂商、测试与默认模型路由均可达', async () => {
    calls.length = 0;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/model-providers',
          headers: auth('admin'),
          payload: { name: 'x', baseUrl: 'https://x/v1', apiKey: 'k' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/models/test',
          headers: auth('admin'),
          payload: { model: 'm1' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/admin/default-model',
          headers: auth('admin'),
          payload: { model: 'm1' },
        })
      ).statusCode,
    ).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(['createProvider', 'testModel', 'setDefault']);
  });
});
```

Run:

```bash
pnpm --filter @ai-office/bff test -- src/admin/admin-models.service.test.ts src/admin/admin-models.controller.test.ts
pnpm --filter @ai-office/bff typecheck
```

Expected: 两个测试文件全部 PASS；typecheck 无输出。`AdminModelsService` 的审计对象需要同时提供 `write` 与 `bestEffort`，测试 fake 已包含。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/dto.ts apps/bff/src/admin/admin-models.service.ts \
  apps/bff/src/admin/admin-models.controller.ts apps/bff/src/admin/admin-models.service.test.ts \
  apps/bff/src/admin/admin-models.controller.test.ts
git commit -m "feat(admin): 支持多厂商模型目录与启用开关

运营端需要集中维护厂商 Base URL、加密 Key、模型价格与启用状态。
新增厂商和模型 CRUD、默认模型设置与连通性测试；模型名可能含斜杠，
更新与删除改走请求体和查询参数。删除/停用受套餐引用与默认模型约束，
避免计费链路出现无价或默认不可用。"
```

> 执行到此，`apps/admin` 前端仍引用旧 API，`pnpm --filter @ai-office/admin test` 会失败；下一个任务立即修复，不要在此处单独运行 admin 测试。

---

## Task 9：运营平台模型页与套餐模型多选

**Files:**
- Modify: `apps/admin/src/lib/admin-api.ts`
- Modify: `apps/admin/src/lib/admin-api.test.ts`
- Rewrite: `apps/admin/src/app/(console)/models/page.tsx`
- Modify: `apps/admin/src/app/(console)/plans/page.tsx`
- Modify: `packages/web-core/src/globals.css`

- [ ] **Step 1: 更新 admin-api 与测试（先失败）**

修改 `apps/admin/src/lib/admin-api.ts`：

1. 导入类型替换为：

```ts
  AdminModelDto,
  AdminModelProviderDto,
  AdminModelsDto,
  AdminModelTestResultDto,
```

删除 `AdminModelPriceDto`。

2. `adminErrorText` 中保留 `admin_failed_400_model_in_use` 并更新文案；保留 `admin_failed_400_invalid_name`（套餐页仍在用）；新增：

```ts
    'admin_failed_400_provider_has_models': '该厂商下仍有模型，请先删除模型',
    'admin_failed_400_default_model_in_use': '当前默认模型不能停用或删除，请先更换默认模型',
    'admin_failed_400_model_in_use': '模型正被启用套餐或有效订阅引用，无法删除',
    'admin_failed_400_provider_required': '必须选择厂商',
    'admin_failed_400_invalid_default_model': '默认模型必须存在且已启用',
    'admin_failed_400_invalid_model': '模型名不能为空',
    'admin_failed_400_invalid_name': '厂商名称不能为空',
    'admin_failed_400_invalid_base_url': 'Base URL 必须是合法的 http/https 地址',
    'admin_failed_400_invalid_api_key': 'API Key 不能为空',
    'admin_failed_400_invalid_display_name': '展示名称不合法',
    'admin_failed_400_invalid_sort_order': '排序必须是非负整数',
    'admin_failed_400_invalid_price': '价格必须是非负整数',
    'admin_failed_400_invalid_provider_id': '厂商 ID 不能为空',
    'admin_failed_400_invalid_enabled': '启用状态必须是布尔值',
    'admin_failed_400_invalid_provider_name': '厂商名称不能为空',
    'admin_failed_400_invalid_provider_patch': '没有需要更新的厂商字段',
    'admin_failed_400_invalid_model_patch': '没有需要更新的模型字段',
    'admin_failed_404_provider_not_found': '厂商不存在',
    'admin_failed_404_model_not_found': '模型不存在',
    'admin_failed_409_provider_exists': '该厂商名称已存在',
    'admin_failed_409_model_exists': '该模型已存在',
    'admin_failed_503_model_provider_unavailable': '厂商密钥无法解密，请联系运维检查 MODEL_ENC_KEY',
    'admin_failed_400_no_models_available': '当前没有可用模型',
```

注意：`admin_failed_400_invalid_name` 在套餐页仍用于「套餐名称不能为空」，所以**保留**这条映射；模型页的厂商名称校验错误码是 `invalid_provider_name`，两者不冲突。

3. 把文件末尾旧的 `createModelPrice`/`updateModelPrice`/`deleteModelPrice` 整段替换为：

```ts
// ------------------------------------------------------------------ 模型
export function getAdminModels(): Promise<AdminModelsDto> {
  return request('/api/admin/models');
}

export function createModelProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<AdminModelProviderDto> {
  return request('/api/admin/model-providers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateModelProvider(
  id: string,
  patch: { name?: string; baseUrl?: string; apiKey?: string },
): Promise<AdminModelProviderDto> {
  return request(`/api/admin/model-providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteModelProvider(id: string): Promise<void> {
  return request(`/api/admin/model-providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function createAdminModel(input: {
  model: string;
  displayName?: string;
  providerId: string;
  enabled?: boolean;
  sortOrder?: number;
  prices: { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number };
}): Promise<AdminModelDto> {
  return request('/api/admin/models', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAdminModel(input: {
  model: string;
  displayName?: string | null;
  providerId?: string;
  enabled?: boolean;
  sortOrder?: number;
  prices?: { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number };
}): Promise<AdminModelDto> {
  return request('/api/admin/models', { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteAdminModel(model: string): Promise<void> {
  return request(`/api/admin/models?model=${encodeURIComponent(model)}`, { method: 'DELETE' });
}

export function testAdminModel(model: string): Promise<AdminModelTestResultDto> {
  return request('/api/admin/models/test', { method: 'POST', body: JSON.stringify({ model }) });
}

export function setDefaultModel(model: string): Promise<AdminModelsDto> {
  return request('/api/admin/default-model', { method: 'PUT', body: JSON.stringify({ model }) });
}
```

修改 `apps/admin/src/lib/admin-api.test.ts`：

- 导入 `createModelProvider`、`updateModelProvider` 替换 `createModelPrice`、`updateModelPrice`。
- 409 用例的响应体 `message` 与调用一起改为：

```ts
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ statusCode: 409, message: 'provider_exists', error: 'Conflict' }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const err = await createModelProvider({
      name: '豆包',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
    }).catch((e) => e);
    expect(err.message).toBe('admin_failed_409_provider_exists');
    expect(adminErrorText(err)).toBe('该厂商名称已存在');
```

- 路径编码用例改为：

```ts
  it('厂商路径参数做 URL 编码，模型名走请求体', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ model: 'm/s p' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await updateModelProvider('p/1', { name: 'x' });
    await updateAdminModel({ model: 'm/s p', enabled: true });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toContain('/api/admin/model-providers/p%2F1');
    expect(String(calls[1][0])).toContain('/api/admin/models');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ model: 'm/s p', enabled: true });
  });
```

- 导入区增加 `updateAdminModel`。

Run: `pnpm --filter @ai-office/admin test -- src/lib/admin-api.test.ts`

Expected: FAIL，直到页面与函数改名完成（本步只要求测试文件反映新接口）。

- [ ] **Step 2: 重写模型页面**

把 `apps/admin/src/app/(console)/models/page.tsx` 整体替换为：

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminModelDto,
  AdminModelsDto,
  AdminModelTestResultDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  createAdminModel,
  createModelProvider,
  deleteAdminModel,
  deleteModelProvider,
  getAdminModels,
  isForbidden,
  setDefaultModel,
  testAdminModel,
  updateAdminModel,
  updateModelProvider,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

/** 与数据库 int 上限保持一致，避免提交后才由服务端报错。 */
const MAX_MILLI_CREDITS = 2_147_483_647;

function parseAmount(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MILLI_CREDITS) return null;
  return value;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

interface ProviderForm {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface ModelForm {
  editing: boolean;
  model: string;
  displayName: string;
  providerId: string;
  enabled: boolean;
  sortOrder: string;
  input: string;
  output: string;
}

function emptyModelForm(providerId = ''): ModelForm {
  return {
    editing: false,
    model: '',
    displayName: '',
    providerId,
    enabled: false,
    sortOrder: '0',
    input: '0',
    output: '0',
  };
}

export default function AdminModelsPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminModelsDto | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AdminModelTestResultDto>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
  const inFlight = useRef(false);

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return true;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return true;
      }
      setError(adminErrorText(err));
      return false;
    },
    [router],
  );

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const next = await getAdminModels();
      if (id !== loadSeq.current) return true;
      setData(next);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshAfterWrite() {
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  async function saveProvider() {
    if (!providerForm || inFlight.current) return;
    setError('');
    setNotice('');
    if (!providerForm.name.trim() || !providerForm.baseUrl.trim()) {
      setError('厂商名称和 Base URL 不能为空');
      return;
    }
    if (!providerForm.id && !providerForm.apiKey.trim()) {
      setError('新增厂商必须填写 API Key');
      return;
    }
    if (!window.confirm(`确认${providerForm.id ? '更新' : '新增'}厂商 ${providerForm.name.trim()}？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (providerForm.id) {
        await updateModelProvider(providerForm.id, {
          name: providerForm.name.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          ...(providerForm.apiKey.trim() ? { apiKey: providerForm.apiKey.trim() } : {}),
        });
      } else {
        await createModelProvider({
          name: providerForm.name.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          apiKey: providerForm.apiKey.trim(),
        });
      }
      setProviderForm(null);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function removeProvider(id: string, name: string) {
    if (inFlight.current) return;
    if (!window.confirm(`确认删除厂商 ${name}？厂商下仍有模型时会被拒绝。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteModelProvider(id);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function saveModel() {
    if (!modelForm || inFlight.current) return;
    setError('');
    setNotice('');
    const name = modelForm.model.trim();
    if (!name) {
      setError('模型名不能为空');
      return;
    }
    if (!modelForm.providerId) {
      setError('必须选择厂商');
      return;
    }
    const input = parseAmount(modelForm.input);
    const output = parseAmount(modelForm.output);
    const order = Number(modelForm.sortOrder);
    if (input === null || output === null) {
      setError('输入/输出必须是非负整数');
      return;
    }
    if (!Number.isSafeInteger(order) || order < 0 || order > 1_000_000) {
      setError('排序必须是非负整数');
      return;
    }
    if (!window.confirm(`确认${modelForm.editing ? '更新' : '新增'}模型 ${name}？`)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const prices = { inputMilliCreditsPer1k: input, outputMilliCreditsPer1k: output };
      const displayName = modelForm.displayName.trim() || null;
      if (modelForm.editing) {
        await updateAdminModel({
          model: name,
          displayName,
          providerId: modelForm.providerId,
          enabled: modelForm.enabled,
          sortOrder: order,
          prices,
        });
      } else {
        await createAdminModel({
          model: name,
          ...(displayName ? { displayName } : {}),
          providerId: modelForm.providerId,
          enabled: modelForm.enabled,
          sortOrder: order,
          prices,
        });
      }
      setModelForm(null);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function toggleModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await updateAdminModel({ model: row.model, enabled: !row.enabled });
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function makeDefault(row: AdminModelDto) {
    if (inFlight.current || row.isDefault) return;
    if (!window.confirm(`确认将 ${row.model} 设为全局默认模型？`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await setDefaultModel(row.model);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function removeModel(row: AdminModelDto) {
    if (inFlight.current) return;
    if (!window.confirm(`确认删除模型 ${row.model}？被默认模型、套餐或有效订阅引用时会被拒绝。`)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteAdminModel(row.model);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[row.model];
        return next;
      });
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function testModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await testAdminModel(row.model);
      setTestResults((prev) => ({ ...prev, [row.model]: result }));
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const providers = data?.providers ?? [];
  const models = data?.models ?? [];

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">模型配置</h1>
            <p className="page-sub">
              维护厂商与模型目录、启用状态、排序和价格；启用且在当前套餐内的模型会展示给客户端。
            </p>
          </div>
          <div className="admin-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="admin-btn primary"
              disabled={busy}
              onClick={() =>
                setProviderForm({ name: '', baseUrl: '', apiKey: '' })
              }
            >
              新增厂商
            </button>
            <button
              type="button"
              className="admin-btn"
              disabled={busy || providers.length === 0}
              onClick={() => setModelForm(emptyModelForm(providers[0]?.id ?? ''))}
            >
              新增模型
            </button>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        {notice && (
          <div
            className="banner"
            role="status"
            style={{ marginBottom: 16, background: 'var(--surface-2)', border: '1px solid var(--line)' }}
          >
            {notice}
          </div>
        )}

        {data?.fallback.active && (
          <div className="banner" style={{ marginBottom: 16, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            当前没有在运营平台配置厂商，客户端使用环境变量兜底：
            {data.fallback.providers.map((p) => `${p.name}（${p.models.join('、')}）`).join('；') || '无'}
          </div>
        )}

        {providerForm && (
          <section className="admin-panel">
            <h2 className="billing-heading">{providerForm.id ? '编辑厂商' : '新增厂商'}</h2>
            <div className="admin-form">
              <label className="admin-field">
                厂商名称
                <input
                  className="admin-input"
                  value={providerForm.name}
                  disabled={busy}
                  placeholder="如：豆包、千问、DeepSeek"
                  onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                />
              </label>
              <label className="admin-field">
                Base URL
                <input
                  className="admin-input"
                  value={providerForm.baseUrl}
                  disabled={busy}
                  placeholder="https://ark.cn-beijing.volces.com/api/v3"
                  onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                />
              </label>
              <label className="admin-field">
                API Key{providerForm.id ? '（留空表示不修改）' : ''}
                <input
                  className="admin-input"
                  type="password"
                  autoComplete="new-password"
                  value={providerForm.apiKey}
                  disabled={busy}
                  onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                />
              </label>
              <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void saveProvider()}>
                保存
              </button>
              <button type="button" className="admin-btn" disabled={busy} onClick={() => setProviderForm(null)}>
                取消
              </button>
            </div>
          </section>
        )}

        {modelForm && (
          <section className="admin-panel">
            <h2 className="billing-heading">{modelForm.editing ? '编辑模型' : '新增模型'}</h2>
            <div className="admin-form">
              <label className="admin-field">
                模型名
                <input
                  className="admin-input"
                  value={modelForm.model}
                  disabled={busy || modelForm.editing}
                  placeholder="如：doubao-pro-32k"
                  onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })}
                />
              </label>
              <label className="admin-field">
                展示名称
                <input
                  className="admin-input"
                  value={modelForm.displayName}
                  disabled={busy}
                  placeholder="如：豆包 Pro 32K"
                  onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })}
                />
              </label>
              <label className="admin-field">
                厂商
                <select
                  className="admin-input"
                  value={modelForm.providerId}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, providerId: e.target.value })}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                排序
                <input
                  className="admin-input"
                  type="number"
                  min={0}
                  max={1_000_000}
                  step={1}
                  value={modelForm.sortOrder}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, sortOrder: e.target.value })}
                />
              </label>
              <label className="admin-field">
                输入（毫积分/1K）
                <input
                  className="admin-input"
                  type="number"
                  min={0}
                  max={MAX_MILLI_CREDITS}
                  step={1}
                  value={modelForm.input}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, input: e.target.value })}
                />
              </label>
              <label className="admin-field">
                输出（毫积分/1K）
                <input
                  className="admin-input"
                  type="number"
                  min={0}
                  max={MAX_MILLI_CREDITS}
                  step={1}
                  value={modelForm.output}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, output: e.target.value })}
                />
              </label>
              <label className="admin-field" style={{ flexDirection: 'row', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={modelForm.enabled}
                  disabled={busy}
                  onChange={(e) => setModelForm({ ...modelForm, enabled: e.target.checked })}
                />
                启用
              </label>
              <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void saveModel()}>
                保存
              </button>
              <button type="button" className="admin-btn" disabled={busy} onClick={() => setModelForm(null)}>
                取消
              </button>
            </div>
          </section>
        )}

        <section className="admin-panel">
          <h2 className="billing-heading">厂商</h2>
          {providers.length === 0 ? (
            <p className="admin-muted">尚未在运营平台配置厂商。</p>
          ) : (
            <div className="admin-cards">
              {providers.map((p) => (
                <div className="admin-card" key={p.id}>
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">{p.name}</div>
                      <div className="admin-card-meta">{p.baseUrl}</div>
                    </div>
                    <span className="admin-muted">{p.modelCount} 个模型</span>
                  </div>
                  <div className="admin-card-meta">Key：{p.apiKeyHint ?? '未设置'}</div>
                  <div className="admin-card-meta">创建于 {formatTime(p.createdAt)}</div>
                  <div className="admin-card-actions">
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy}
                      onClick={() =>
                        setProviderForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: '' })
                      }
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={busy}
                      onClick={() => void removeProvider(p.id, p.name)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : models.length === 0 ? (
          <div className="admin-empty">暂无模型</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>厂商</th>
                <th>启用</th>
                <th>排序</th>
                <th>输入</th>
                <th>输出</th>
                <th>默认</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const result = testResults[m.model];
                return (
                  <tr key={m.model}>
                    <td>
                      <div>{m.displayName}</div>
                      <div className="admin-muted">{m.model}</div>
                      {result && (
                        <div className={result.ok ? 'admin-muted' : 'banner-error'} style={{ marginTop: 4 }}>
                          {result.ok ? `连接正常（${result.latencyMs}ms）` : `测试失败：${result.error ?? '未知错误'}`}
                        </div>
                      )}
                    </td>
                    <td>{m.providerName ?? '未绑定'}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        disabled={busy}
                        aria-label={`启用模型 ${m.model}`}
                        onChange={() => void toggleModel(m)}
                      />
                    </td>
                    <td className="numeric">{m.sortOrder}</td>
                    <td className="numeric">{m.inputMilliCreditsPer1k}</td>
                    <td className="numeric">{m.outputMilliCreditsPer1k}</td>
                    <td>{m.isDefault ? '★ 默认' : <button type="button" className="admin-btn" disabled={busy} onClick={() => void makeDefault(m)}>设为默认</button>}</td>
                    <td>{formatTime(m.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="admin-btn"
                        disabled={busy}
                        onClick={() =>
                          setModelForm({
                            editing: true,
                            model: m.model,
                            displayName: m.displayName,
                            providerId: m.providerId ?? providers[0]?.id ?? '',
                            enabled: m.enabled,
                            sortOrder: String(m.sortOrder),
                            input: String(m.inputMilliCreditsPer1k),
                            output: String(m.outputMilliCreditsPer1k),
                          })
                        }
                      >
                        编辑
                      </button>{' '}
                      <button type="button" className="admin-btn" disabled={busy} onClick={() => void testModel(m)}>
                        测试
                      </button>{' '}
                      <button type="button" className="admin-btn" disabled={busy} onClick={() => void removeModel(m)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 增加管理端卡片/多选样式**

在 `packages/web-core/src/globals.css` 管理端段落（`.admin-panel` 之后）增加：

```css
.admin-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.admin-card {
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.admin-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.admin-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.admin-card-meta {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
  word-break: break-all;
}

.admin-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.admin-checks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}

.admin-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  color: var(--ink);
}
```

- [ ] **Step 4: 套餐页改为模型多选**

修改 `apps/admin/src/app/(console)/plans/page.tsx`：

1. 导入区增加：

```ts
import type { AdminModelDto } from '@ai-office/shared';
import { getAdminModels } from '../../../lib/admin-api';
```

2. 状态增加：

```ts
  const [catalog, setCatalog] = useState<AdminModelDto[]>([]);
  const [catalogError, setCatalogError] = useState('');
```

3. 增加加载函数并在挂载时调用：

```ts
  useEffect(() => {
    let cancelled = false;
    getAdminModels()
      .then((data) => {
        if (!cancelled) setCatalog(data.models);
      })
      .catch((err) => {
        if (!cancelled) setCatalogError(adminErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);
```

4. 删除 `modelsText` 状态与所有 `setModelsText` 调用。

5. `startEdit` 中删除 `setModelsText(plan.allowedModels.join(','));`。

6. `resetForm` 中删除 `setModelsText('');`。

7. `save()` 中把：

```ts
    const payload: AdminPlanInput = {
      ...form,
      allowedModels: modelsText.split(',').map((m) => m.trim()).filter(Boolean),
    };
```

改为：

```ts
    const payload: AdminPlanInput = {
      ...form,
      allowedModels: form.allowedModels,
    };
    if (payload.allowedModels.length === 0) {
      setError('请至少选择一个允许模型');
      return;
    }
```

8. 把表单里的「允许模型」输入框整段：

```tsx
            <label className="admin-field">
              允许模型（逗号分隔）
              <input className="admin-input" value={modelsText} disabled={busy} onChange={(e) => setModelsText(e.target.value)} />
            </label>
```

替换为：

```tsx
            <div className="admin-field" style={{ minWidth: 280 }}>
              允许模型
              {catalogError && <span className="banner-error">{catalogError}</span>}
              <div className="admin-checks">
                {[
                  ...catalog,
                  ...form.allowedModels
                    .filter((m) => !catalog.some((c) => c.model === m))
                    .map((model) => ({
                      model,
                      displayName: model,
                      enabled: false,
                      providerName: null,
                    })),
                ].map((m) => {
                  const checked = form.allowedModels.includes(m.model);
                  return (
                    <label className="admin-check" key={m.model}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            allowedModels: e.target.checked
                              ? [...form.allowedModels, m.model]
                              : form.allowedModels.filter((x) => x !== m.model),
                          })
                        }
                      />
                      <span>
                        {m.displayName || m.model}
                        {!m.enabled ? '（已停用）' : ''}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
```

> 若套餐页 import 中尚未包含 `useEffect`，一并补上。

- [ ] **Step 5: 运行管理端测试与构建**

Run:

```bash
pnpm --filter @ai-office/admin test
pnpm --filter @ai-office/admin build
```

Expected: 测试通过；`next build` 成功。构建前停掉本地 admin dev server。

- [ ] **Step 6: 提交**

```bash
git add apps/admin/src/lib/admin-api.ts apps/admin/src/lib/admin-api.test.ts \
  'apps/admin/src/app/(console)/models/page.tsx' 'apps/admin/src/app/(console)/plans/page.tsx' \
  packages/web-core/src/globals.css
git commit -m "feat(admin): 重做模型配置页并改为套餐模型多选

运营人员需要在一个页面完成厂商、模型、启用、排序、默认与连通性测试，
旧的单一价格表单无法表达多厂商关系。套餐允许模型改为从目录勾选，
停用模型仍可见但标注，避免手输模型名造成拼写错误与无价引用。"
```

---

## Task 10：部署配置与文档

**Files:**
- Modify: `.env.example`
- Modify: `.env.docker.example`
- Modify: `scripts/deploy.sh`
- Modify: `docs/deploy/06-deployment.md`

- [ ] **Step 1: 更新本地/容器环境模板**

`.env.example`：在 `CONNECTOR_ENC_KEY=` 下方增加：

```bash
# 模型厂商 API Key 的 AES-256-GCM 密钥（32 字节 hex，必须设置；与连接器密钥分开轮换）
# 生成：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MODEL_ENC_KEY=
```

`.env.docker.example`：把应用密钥注释改为：

```bash
# 应用密钥（由部署脚本生成随机值；CONNECTOR_ENC_KEY / MODEL_ENC_KEY 必须是 32 字节 hex）
```

并在 `CONNECTOR_ENC_KEY=` 下方增加：

```bash
MODEL_ENC_KEY=
```

- [ ] **Step 2: 部署脚本生成模型密钥**

修改 `scripts/deploy.sh`，在：

```bash
  set_kv CONNECTOR_ENC_KEY "$(hex 32)" "$ENV_FILE"
```

下方增加：

```bash
  set_kv MODEL_ENC_KEY "$(hex 32)" "$ENV_FILE"
```

- [ ] **Step 3: 更新部署文档**

在 `docs/deploy/06-deployment.md` 的环境变量表中，`CONNECTOR_ENC_KEY` 行之后增加：

```markdown
| `MODEL_ENC_KEY` | 空 | **必须设置**（32 字节 hex）；运营平台模型厂商 API Key 的加解密密钥，缺失时 BFF 启动失败；与 `CONNECTOR_ENC_KEY` 分开轮换 |
```

在「模型服务」相关说明段落中补充一句：

```markdown
> 生产环境优先在运营平台「模型配置」里维护厂商与模型；`.env` 中的 `DEEPSEEK_API_KEY` / `MODEL_PROVIDERS` 仅作为未配置数据库厂商时的兜底。
```

- [ ] **Step 4: 本地 `.env` 补键**

若本地根目录存在 `.env`，在其中加入一行（值用下面的命令生成）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
MODEL_ENC_KEY=<上一步输出>
```

`.env` 不入库，不要 `git add .env`。

- [ ] **Step 5: 提交**

```bash
git add .env.example .env.docker.example scripts/deploy.sh docs/deploy/06-deployment.md
git commit -m "chore(deploy): 增加模型密钥配置

模型厂商 API Key 使用独立的 AES-256-GCM 密钥加密存储，部署脚本需要
自动生成该密钥，否则 BFF 启动自检失败。文档同步说明数据库厂商优先、
环境变量仅作兜底。"
```

---

## Task 11：全量验证与手工验收

**Files:** 无新增代码；按需修复上一步暴露的问题（修复必须补对应测试）。

- [ ] **Step 1: 全量安装、构建与测试**

Run:

```bash
pnpm install
pnpm --filter @ai-office/shared build
pnpm --filter @ai-office/bff test
pnpm --filter @ai-office/bff typecheck
pnpm --filter @ai-office/agent-runtime test
pnpm --filter @ai-office/agent-runtime typecheck
pnpm --filter @ai-office/web test
pnpm --filter @ai-office/web-core test
pnpm --filter @ai-office/admin test
```

Expected: 全部通过。任何失败先按测试输出修复并补测，不要跳过。

- [ ] **Step 2: 三个前端构建**

先停掉本地 dev server（`next build` 与 dev 共用 `.next` 会互相破坏），再运行：

```bash
pnpm --filter @ai-office/web build
pnpm --filter @ai-office/admin build
```

Expected: 均成功。

- [ ] **Step 3: 数据库与种子回归**

Run:

```bash
pnpm --filter @ai-office/bff db:push
pnpm --filter @ai-office/bff db:seed:billing
```

Expected: schema 同步成功；种子日志 `已写入 4 个套餐、3 条模型价格`。

- [ ] **Step 4: 启动四个服务**

分别开四个终端（或使用已有脚本）：

```bash
pnpm --filter @ai-office/bff dev
pnpm --filter @ai-office/agent-runtime dev
pnpm --filter @ai-office/web dev
pnpm --filter @ai-office/admin dev
```

确保 BFF 启动日志中没有 `MODEL_ENC_KEY 未设置`。若本地 `.env` 缺该键，按 Task 10 Step 4 补齐后重启。

- [ ] **Step 5: 手工验收（按设计 §10.4）**

1. 用管理员登录运营平台 `http://localhost:3001/models`。
2. 新增厂商（例如 DeepSeek）：名称、Base URL、真实 API Key；确认卡片只显示 `****后四位`。
3. 新增两个模型：一个启用、一个停用；给两者都填价格与排序。
4. 点击「测试」：启用模型应显示连接正常或返回上游错误（错误中不得出现完整 Key）；停用模型也可测试。
5. 勾选停用模型的启用开关 → 表格状态变化；尝试停用默认模型 → 页面提示「当前默认模型不能停用或删除」。
6. 进入套餐页，编辑 `free` 套餐：只勾选启用的模型；确认停用模型标注「（已停用）」，未配置模型标注为未启用。
7. 用普通用户登录 Web `http://localhost:3000`：
   - 新建任务时模型下拉只显示「已启用 ∩ 套餐内」模型；
   - 选择第二个模型发送一条消息，事件中应出现 `思考 · 实际模型`；
   - 刷新页面重开会话，模型选择器锁定并显示该会话模型，提示「切换模型请新建任务」。
8. 在运营平台停用该会话使用的模型，刷新 Web：
   - 该会话提示「该会话使用的模型已停用，请新建任务」，发送按钮禁用；
   - 新建任务时不再出现该模型。
9. 将某模型 Base URL 改成不可达地址后运行，观察到 runtime 回退到同一排程序中的下一个模型，事件标注实际模型；计费记录按实际模型归集。
10. 检查 BFF 日志与审计表：没有明文 API Key；审计包含 `modelProvider.create`、`model.create`、`model.default`、`model.test`。

- [ ] **Step 6: 提交验收修复（如有）并确认工作区**

```bash
git status --short
```

Expected: 只剩已知的 `apps/bff/prisma/comments.sql` 未提交改动（与本需求无关，不要提交）。若验收过程有修复，逐个补测后提交，commit message 用中文说明原因。

---

## 设计覆盖对照

| 设计要求 | 对应任务 |
|---|---|
| 多厂商 Base URL / Key 管理，Key 加密存储 | Task 1、8 |
| 模型启用属性、排序、价格目录 | Task 2、8 |
| 客户端只展示「启用 ∩ 套餐」模型 | Task 4、7 |
| 运营端全局默认模型与失效回退 | Task 4、8 |
| 按会话固定模型，新建时选择 | Task 2、5、7 |
| 运行前解密并下发路由，runtime 无 DB | Task 4、5、6 |
| 429/5xx 自动回退并标注实际模型 | Task 6、7 |
| 按实际模型计费 | Task 6（`resp.model` 不变）、Task 5（billing 透传） |
| 套餐过期/模型停用/密钥不可用错误码 | Task 4、5 |
| 历史会话模型回填 | Task 5 |
| 环境变量兼容与 Mock 兜底 | Task 3、4 |
| 删除/停用默认模型与套餐引用保护 | Task 8 |
| 部署密钥与文档 | Task 10 |
| 全量测试与手工验收 | Task 11 |
