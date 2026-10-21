# 多厂商模型配置与客户端模型选择 · 设计文档

- 日期：2026-10-21
- 状态：已确认
- 范围：运营端模型配置、BFF 模型目录与路由、runtime 动态模型路由、客户端模型选择与会话固定模型
- 决策：方案 A（厂商表 + 模型目录，BFF 按运行下发路由）

## 1. 背景与目标

当前模型配置只有两张皮：

- 运行时从环境变量 `MODEL_PROVIDERS` 读取厂商、Base URL 与 `apiKeyEnv`，进程启动时构建一次静态 `RoutingGateway`；
- 运营端只有「模型价格」CRUD，厂商信息是只读的环境变量解析结果，无法增删改，也没有启用开关。

因此只能通过改环境变量、重启服务来接入新厂商；客户端无法感知有哪些模型，更不能选择。

**目标**

- 运营端管理多个厂商（豆包、千问、DeepSeek、OpenAI、Kimi、MiniMax、GLM 等）及其模型，凭据加密入库。
- 每个模型有独立的启用开关、展示名、排序与价格。
- 运营端指定全局默认模型。
- 客户端只展示「全局启用 ∩ 当前套餐允许」的模型，用户新建任务时选择，选择随会话固定。
- 配置变更即时生效，不需要重启 BFF 或 runtime。
- 环境变量配置保留为兼容兜底，存量部署升级后不中断。

**非目标**

- 不接入非 OpenAI 兼容协议（Anthropic 原生、Gemini 原生等）。本期所有厂商统一走 `/chat/completions`。
- 不支持用户自带 Key、按用户计费或多租户独立厂商配置；厂商凭据是平台级配置。
- 不增加模型能力元数据（上下文长度、是否支持工具调用、多模态等）。当前上架模型默认具备 function calling 能力。
- 不支持会话中途切换模型；切换必须新建任务。
- 不做模型级限流、A/B 分流或灰度。
- 不改动计费公式与积分结算逻辑。

## 2. 已确认的关键决策

| 议题 | 决策 |
|---|---|
| 凭据位置 | 全部在运营平台配置；厂商名、Base URL、API Key、模型清单、价格、启用均可编辑；密钥 AES-256-GCM 加密入库；环境变量仅作兜底 |
| 客户端可见范围 | 「全局启用 ∩ 当前套餐 `allowedModels`」；服务端在创建会话与发起任务时同样校验，套餐外或已停用的模型不可见也不可用 |
| 选择粒度 | 按会话固定；新建任务时选择，写入 `Session.model`；重新打开会话仍保留；切换模型需新建任务 |
| 默认模型 | 运营端指定全局默认（必须启用）；默认模型对当前套餐不可用时，回落到该套餐可用模型中的第一个 |
| 失败回退 | 选中模型遇 429 / 5xx / 网络异常时，自动在本次可用模型内按运营端排序切换；消息标注实际应答模型；计费按实际模型结算 |
| 运行链路 | BFF 每次任务解析路由并随 `RunRequest` 下发；runtime 为本次 run 构建网关，保持无数据库依赖 |

## 3. 数据模型与迁移

### 3.1 新增 `ModelProvider`

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
```

- `name`：厂商展示名，唯一，用于运营端与客户端展示。
- `baseUrl`：OpenAI 兼容根地址，例如 `https://api.deepseek.com/v1`、`https://dashscope.aliyuncs.com/compatible-mode/v1`。保存时去除末尾 `/`，只允许 `http` / `https`。网关自行拼接 `/chat/completions`。
- `apiKeyEnc`：AES-256-GCM 密文，格式与连接器一致：`base64(IV ‖ authTag ‖ ciphertext)`。
- `apiKeyHint`：密钥末 4 位（不足 4 位存 `****`），只用于后台掩码展示，不可逆推。
- 厂商删除受 `Restrict` 保护：只要还有模型归属，删除返回 400。

### 3.2 扩展现有 `ModelPrice` 为模型目录

Prisma 模型改名 `ModelConfig`，通过 `@@map("ModelPrice")` 沿用原表名，迁移只加列，不搬数据：

```prisma
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

  @@map("ModelPrice")
  @@index([providerId])
  @@index([enabled, sortOrder])
}
```

- `model` 仍是全局唯一主键，`Plan.allowedModels` 继续存模型 ID，计费 `loadPrices` 读取路径不变。
- 价格与模型同表，新建模型必须带价格，启用前天然保证有价可算。
- 存量价格行迁移后为「未绑定厂商、`enabled=false`、`displayName=null`」：不会出现在客户端，运营端显示为「未绑定厂商」，可编辑绑定后复用。
- `providerId` 可空仅用于承接存量行；新建模型必须绑定厂商。
- 模型停用不影响存量订阅的历史计费：价格仍在同一行，`beginRun` 的价格校验不变。

### 3.3 会话固定模型

```prisma
model Session {
  // 既有字段...
  model String?
}
```

- `Session.model` 存模型 ID，可空以兼容存量会话。
- 存量会话首次发起任务时，BFF 解析当前默认模型并写回 `Session.model`，此后固定。
- 不新增 `Session` 外键：模型可能被删除/停用，历史会话仍需可读；运行前校验可用性。

### 3.4 默认模型存储

默认模型存 `Setting` 表，键 `defaultModel`，值为 JSON 字符串（模型 ID）：

- 由模型管理接口维护，不进入通用设置页的 `SETTING_SPECS` 白名单。
- 写入时校验：模型存在、已启用、已绑定厂商。
- 停用或删除当前默认模型时返回 400 `default_model_in_use`，要求先指定其他默认。
- 未设置默认模型（或存量数据没有设置）时，取「已启用、已绑定厂商、按 `sortOrder`、`model` 排序」的第一个。
- 若显式默认模型不在当前租户套餐的可用集合内，回落为该集合按同样规则排序的第一个。

### 3.5 迁移步骤

1. 新增 `ModelProvider`、扩展 `ModelPrice`、`Session` 加列，生成 Prisma 迁移。
2. 不自动导入环境变量：存量部署仍走兜底；运营端配置首个厂商后自动切换为数据库配置。
3. 不删除、不改写任何 `ModelPrice` 行。

## 4. 密钥与安全

### 4.1 通用加密模块

把 `apps/bff/src/connector/crypto.ts` 中的 AES-256-GCM 实现抽到 `apps/bff/src/secrets/secret-box.ts`：

```ts
export function assertSecretKey(envName: string): void;
export function encryptSecret(plain: string, envName: string): string;
export function decryptSecret(blob: string, envName: string): string;
```

- 连接器继续使用 `CONNECTOR_ENC_KEY`，行为与密文格式不变。
- 模型厂商使用新的 `MODEL_ENC_KEY`（32 字节 hex），与连接器密钥分离。
- BFF 启动时同时校验两个密钥（`main.ts`），缺失或格式错误直接失败，避免运行到首次保存厂商才暴露。
- `.env.example`、`.env.docker.example`、`scripts/deploy.sh`、`docs/deploy/06-deployment.md` 同步补充生成与说明。

### 4.2 密钥生命周期

- 唯一明文出现点：运营端提交表单 → BFF 立即加密；运行前解密 → 仅进入进程内存与内网 `RunRequest`。
- 任何读取接口都不返回明文；`GET /api/admin/models` 只返回 `apiKeyHint`。
- 编辑厂商时 `apiKey` 省略或为空表示不修改；提交新值则重新加密并更新提示。
- 解密失败（密钥轮换、密文损坏）时，任务在预占额度前失败，返回 503 `model_provider_unavailable`；日志只记录厂商 ID，不记录密文或明文。
- 运营端「测试连接」使用已存密钥，不把密钥回传前端。

### 4.3 内网传输

`RunRequest.modelRoutes` 含明文 Key，仅通过 BFF → runtime 的内网 HTTP 调用传递：

- 沿用 `AGENT_RUNTIME_TOKEN`（未配置时仅放行回环来源）。
- 请求体不写日志；trace 只记录 `runId`、模型名与状态。
- 路由只在单次 run 的生命周期内存在，不落库、不缓存。

## 5. 运营端接口与页面

### 5.1 接口

所有接口挂在 `/api/admin`，沿用 `JwtGuard + AdminGuard`，写操作与审计同事务。

| 方法 | 路径 | 请求 | 返回 |
|---|---|---|---|
| GET | `/models` | — | `AdminModelsDto` |
| POST | `/model-providers` | `{ name, baseUrl, apiKey }` | `AdminModelProviderDto` |
| PATCH | `/model-providers/:id` | `{ name?, baseUrl?, apiKey? }` | `AdminModelProviderDto` |
| DELETE | `/model-providers/:id` | — | 204 |
| POST | `/models` | `{ model, displayName, providerId, enabled?, sortOrder?, inputMilliCreditsPer1k, outputMilliCreditsPer1k }` | `AdminModelDto` |
| PATCH | `/models` | `{ model, ...可编辑字段子集 }` | `AdminModelDto` |
| DELETE | `/models?model=<id>` | — | 204 |
| POST | `/models/test` | `{ model }` | `AdminModelTestResultDto` |
| PUT | `/default-model` | `{ model }` | `{ defaultModel }` |

模型 ID 可能包含 `/`（如某些聚合网关的 `vendor/model`），因此模型读写不使用路径参数：更新与测试把模型 ID 放在请求体，删除放在查询参数，避免 URL 分段问题。

原 `/model-prices` 三个接口删除，管理端是唯一调用方。

```ts
export interface AdminModelProviderDto {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string | null;
  modelCount: number;
  createdAt: string;
}

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

export interface AdminLegacyProviderDto {
  name: string;
  models: string[];
}

export interface AdminModelsDto {
  providers: AdminModelProviderDto[];
  models: AdminModelDto[];
  /** 实际生效的默认模型；无可用模型时为 null。 */
  defaultModel: string | null;
  fallback: {
    /** 数据库中没有厂商时为 true，此时使用环境变量兜底。 */
    active: boolean;
    providers: AdminLegacyProviderDto[];
  };
}

export interface AdminModelTestResultDto {
  ok: boolean;
  latencyMs: number;
  /** 上游失败时的脱敏错误摘要，不含密钥。 */
  error?: string;
}
```

**校验规则**

- 厂商名非空、唯一，长度 1–40；Base URL 可解析、协议为 http/https、长度不超过 500；API Key 非空（更新时可省略）。
- 模型 ID 去除首尾空白后非空、全局唯一、长度不超过 200；展示名缺省时用模型 ID，最长 60；价格沿用现有非负 Int32 校验；`sortOrder` 为 0–9999 的整数。
- 启用模型要求 `providerId` 非空且厂商已配置密钥。
- 删除模型沿用现有保护：被启用中的套餐引用，或被未到期订阅的套餐引用时拒绝（`model_in_use`）。
- 删除厂商要求其模型数为 0（`provider_has_models`）。
- 默认模型必须存在且已启用；停用/删除当前默认模型返回 400 `default_model_in_use`。

**测试连接**

- BFF 用该模型的厂商 `baseUrl` 与解密后的 Key，发起一次非流式补全：
  `POST {baseUrl}/chat/completions`，`{ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }`。
- 10 秒超时；上游非 2xx 或网络错误时返回 `ok:false` 与截断到 300 字符、脱敏后的错误摘要。
- 测试结果写入审计（`model.test`，记录模型与结果，不记录密钥）。

**审计动作**

`modelProvider.create / update / delete`、`model.create / update / delete`、`model.default.update`、`model.test`。厂商更新摘要只记录名称、Base URL 是否变化、密钥是否更换，不记录密钥或密文。

### 5.2 运营端页面

「模型」页重构为上下两块：

**厂商区**

- 卡片或表格：厂商名、Base URL、密钥掩码（如 `••••a1b2`）、模型数、创建时间。
- 操作：新建厂商、编辑、删除（有模型时禁用并提示先迁移/删除模型）。
- 新建/编辑弹窗：名称、Base URL、API Key；编辑时 Key 留空表示不修改，placeholder 显示当前掩码。

**模型区**

- 表格列：展示名与模型 ID、所属厂商、输入/输出价格、启用开关、默认星标、排序、操作（测试、编辑、删除）。
- 未绑定厂商的存量价格行显示「未绑定厂商」，可编辑绑定。
- 新建/编辑弹窗：厂商下拉、模型 ID、展示名、输入/输出价格、排序、启用。
- 启用开关即时保存；关闭当前默认模型时就地提示「请先将其他模型设为默认」。
- 默认星标点击即调用 `PUT /default-model`；未启用模型不可设为默认。
- 「测试」按钮逐模型执行，显示「耗时 Xms」或错误摘要；厂商密钥缺失时禁用。
- 数据库没有厂商时，页面顶部显示「当前使用环境变量兜底」横幅，列出兜底模型 ID。

**套餐页**

- `allowedModels` 从逗号分隔文本改为模型多选：
  - 选项来自 `GET /api/admin/models` 的全部模型；
  - 已停用模型标注「（已停用）」，仍保留勾选状态，便于运营发现并清理；
  - 保存仍提交模型 ID 数组，不改变 `Plan` 结构。
- 未勾选任何模型时允许保存，但页面提示「该套餐用户将无可用模型」。

## 6. 客户端模型列表与选择

### 6.1 客户端接口

新增 `GET /api/models`（JWT）：

```ts
export interface ClientModelDto {
  model: string;
  displayName: string;
  providerName: string;
}

export interface ClientModelsDto {
  models: ClientModelDto[];
  /** 实际生效的默认模型；无可用模型时为空串。 */
  defaultModel: string;
}
```

解析规则：

1. 通过 `BillingService.ensureSubscription` 取当前套餐；订阅非 active 或已过期时返回 402 `plan_expired`，避免展示无法使用的模型。
2. 数据库存在厂商时：取 `enabled=true`、已绑定厂商且厂商已配置密钥的模型，与 `plan.allowedModels` 取交集。列表阶段不解密密钥；解密失败在发起任务时按 503 处理。
3. 数据库没有任何厂商时：解析环境变量兜底——`MODEL_PROVIDERS` 中有对应密钥的模型 → 否则 `DEEPSEEK_API_KEY` + `MODEL_NAME`；仍与 `plan.allowedModels` 取交集。若完全没有可路由模型（本地 Mock 场景），返回 `plan.allowedModels` 列表、`providerName='环境变量'`，由 runtime 的启动网关兜底。
4. 排序：`sortOrder` 升序，再按 `model` 字典序。
5. 默认模型：显式 `defaultModel` 在交集内则使用；否则取排序第一个；交集为空返回空串。

`POST /api/sessions` 扩展：

```ts
export interface CreateSessionRequest {
  title?: string;
  model?: string;
}
```

- 传 `model` 时必须在当前可用集合内，否则 400 `invalid_model`。
- 未传时写入解析后的默认模型。
- 可用集合为空时返回 400 `no_models_available`。
- `SessionSummary` 增加 `model: string | null`，列表接口原样回传。

### 6.2 客户端页面

**模型选择器**

- 位置：输入框上方左侧，与输入区同宽；原生 `<select>` 加样式，保证键盘与读屏可用。
- 选项文案：`展示名 · 厂商名`；默认值取 `GET /api/models` 的 `defaultModel`。
- 仅「新任务」草稿态可编辑；已有会话只读，title/提示为「该会话已固定模型，切换请新建任务」。
- 运行中禁用选择器。
- 「新建任务」不再立即创建空会话：清空当前会话与对话状态，进入草稿态；首次发送时才调用 `POST /api/sessions` 并带上所选模型。这样用户可以在发送前选模型，同时避免无消息的空会话堆积。
- 页面加载时仍自动选中最近一个会话；要看模型列表需点「新建任务」。
- `GET /api/models` 在页面加载与进入新任务草稿态时各拉取一次，确保默认模型与可用列表是最新的。
- 可用模型为空时，禁用发送按钮并提示「当前套餐暂无可用模型，请联系管理员」。

**会话模型不可用**

- 客户端把会话的 `model` 与 `GET /api/models` 对比；不在列表时：
  - 选择器显示该模型 ID 并标注「已停用」；
  - 禁用发送；
  - 显示提示「当前会话的模型已不可用，请新建任务」。
- 存量会话 `model` 为空时，选择器展示当前默认模型；首次发送由 BFF 写回会话。

**实际模型标注**

- 每条 `think` 事件展示「思考 · 模型展示名」。
- 若该事件的模型与会话选中模型不同，追加「（已自动切换）」。
- 模型展示名从 `GET /api/models` 映射；映射不到时直接显示模型 ID。

## 7. 任务与运行链路

### 7.1 共享 DTO

```ts
export interface RunModelRoute {
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface RunRequest {
  // 既有字段...
  /** BFF 本次运行解析出的模型路由，选中模型在首位；缺省时 runtime 使用启动配置。 */
  modelRoutes?: RunModelRoute[];
}

export interface RunBilling {
  maxCredits: number;
  allowedModels: string[];
  selectedModel?: string;
  prices: Record<string, ModelPriceDto>;
}

export interface AgentEvent {
  // 不变；think 的 payload 增加 model
}
```

### 7.2 BFF

新增 `ModelsModule`：

- `ModelCatalogService.listAvailable(tenantId)`：实现 6.1 的可用模型与默认模型解析，供 `/api/models` 与 `POST /api/sessions` 使用。
- `ModelCatalogService.resolveForRun(tenantId, sessionModel)`：
  - 复用 `listAvailable` 的内部数据（含厂商 Base URL 与密文）；
  - 校验 `sessionModel`，不在集合内抛 `ModelUnavailableError`（409 `model_unavailable`）；
  - 逐个解密模型所属厂商的 Key：选中模型解密失败抛 `ModelProviderUnavailableError`（503）；其余厂商解密失败只记日志并从回退路由中剔除，不影响本次运行；
  - 返回 `{ selectedModel, routes }`，routes 顺序为「选中模型在前，其余按运营端排序」；解密后没有剩余路由时抛 503。
- 解密失败的日志只记录厂商 ID，不记录密文或明文。

`TasksController.run` 流程调整：

1. `assertOwned` 改为返回会话行（包含 `model`），保持 404 早于预占。
2. 读取运行配置。
3. 调用 `resolveForRun`；失败在 hijack 与预占之前返回 402/409/503。
4. `beginRun` 预占额度（价格校验保持现状）。
5. 预占成功后，若会话 `model` 为空，用 `resolveForRun` 返回的 `selectedModel` 写回 `Session.model`；预占失败不产生写入。
6. `billing.selectedModel = selectedModel`，`RunRequest.modelRoutes = routes`。
7. 其余 SSE 转发、用量记录、结算逻辑不变。

`SessionsService.list` 返回 `model`；`create` 接收 `model` 并写入；`messages` 契约不变。

### 7.3 runtime

- `create-gateway.ts` 新增 `createGatewayFromRoutes(routes, observer)`：
  - 空数组返回 `undefined`；
  - 每个路由构造 `OpenAICompatGateway`，整体包进 `RoutingGateway`；
  - 校验模型名重复与空 baseUrl/key，非法时抛错。
- `server.ts` 在每次 run 内：
  `const runGateway = createGatewayFromRoutes(runReq.modelRoutes, observer) ?? gateway;`
  - `observer` 沿用现有指标回调，每次尝试与回退照常打点。
- `agent-loop.ts`：
  - 计算本次请求的模型顺序：`selectedModel` 在首位，其余按 `billing.allowedModels` 中顺序去重；
  - `gateway.chat({ messages, tools, models: orderedModels })`；
  - `think` 事件 payload 增加 `model: resp.model`。
- 回退逻辑不变：仅 429 / 5xx / 网络异常尝试下一个模型；其他错误直接暴露。
- 没有 `modelRoutes` 的旧 BFF 请求继续使用启动时创建的环境变量网关或 MockGateway。

### 7.4 计费

- 预占额度仍按套餐 `maxCreditsPerRun`。
- 用量按 `resp.model` 归集，回退后的实际模型参与结算。
- `beginRun` 对套餐内所有模型的价格校验不变；模型被停用但仍在套餐内时仍要求存在价格。
- 不新增模型级配额或价格倍率。

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| 厂商名重复 | 409 `provider_exists` |
| 模型 ID 重复 | 409 `model_exists` |
| 厂商仍有模型 | 400 `provider_has_models` |
| 模型被套餐/订阅引用 | 400 `model_in_use` |
| 停用/删除当前默认模型 | 400 `default_model_in_use` |
| 启用未绑定厂商的模型 | 400 `provider_required` |
| 默认模型不存在或未启用 | 400 `invalid_default_model` |
| 客户端提交未知模型 | 400 `invalid_model` |
| 套餐无可用模型 | 400 `no_models_available` |
| 会话模型已停用/移出套餐 | 409 `model_unavailable` |
| 套餐已过期 | 客户端模型列表与会话创建返回 402 `plan_expired` |
| 厂商密钥解密失败 | 选中模型的厂商失败返回 503 `model_provider_unavailable`；回退模型的厂商失败只记日志并跳过 |
| 测试连接上游失败 | HTTP 200，`{ ok:false, error }`；参数错误仍为 400 |
| 运行中选中模型 429/5xx/网络错误 | runtime 自动回退，`think.model` 标注实际模型 |
| 运行中非重试错误 | 按现有 SSE `error` 事件返回，不换模型 |

所有错误码只出现在接口响应与前端提示映射中，不向终端用户暴露 Base URL、厂商响应原文或密钥。

## 9. 兼容性与部署

- **旧客户端**：不传 `model` 创建会话、不读 `modelRoutes` 的客户端仍可运行；BFF 会用默认模型补全会话，runtime 收到空路由时回退到启动网关。
- **旧 BFF + 新 runtime**：runtime 忽略不存在的字段，行为不变。
- **环境变量兜底**：数据库无厂商时，`/api/models` 与运行路由完全复刻 runtime 的 `MODEL_PROVIDERS` → `DEEPSEEK_API_KEY` → Mock 逻辑；运营端配置首个厂商后以数据库为准。
- **存量价格**：保留为未绑定、未启用的模型行；计费与套餐引用不受影响。
- **存量会话**：`model` 为空，首次运行时写回默认模型；不对历史数据做批量回填。
- **新增环境变量**：`MODEL_ENC_KEY`（32 字节 hex），BFF 启动强制校验；部署脚本首次部署时自动生成，升级部署需在 `.env` 中补充后重启。本地开发需同步写入 `.env`，测试环境在启动前注入。
- **无数据库迁移脚本**：Prisma migrate 生成加表/加列，不包含数据搬运。

## 10. 测试策略

### 10.1 BFF

- `secret-box`：加解密往返、错误密钥失败、缺失/非法 `MODEL_ENC_KEY` 启动校验。
- 厂商 CRUD：
  - 创建时只入库密文与末 4 位提示；
  - 更新留空不改变密钥，提交新值更换密文；
  - 重名 409、删除仍有模型的厂商 400；
  - 读接口不出现明文。
- 模型 CRUD：
  - 价格与排序校验；
  - 启用未绑定厂商 400；
  - 停用/删除默认模型 400；
  - 被启用套餐引用时删除 400（沿用现有用例）。
- 默认模型：设置、未设置时回落首项、默认不在套餐内时回落首个可用。
- `ModelCatalogService`：
  - 数据库模型与套餐交集、排序；
  - 停用模型不出现；
  - 环境变量兜底路径（有 `MODEL_PROVIDERS`、仅有 `DEEPSEEK_API_KEY`、无密钥 Mock）；
  - `resolveForRun` 路由顺序、选中模型校验、解密失败 503。
- 会话：
  - 创建时传合法/非法/缺省模型；
  - 列表返回 `model`；
  - 存量 `model=null` 首次运行写回。
- 任务：
  - `RunRequest` 携带 `modelRoutes` 与 `billing.selectedModel`；
  - 不可用模型在预占前返回 409，不留下 `CreditHold`；
  - 正常路径的 SSE 代理与结算用例保持通过。
- 管理端控制器：管理员守卫、测试连接结果与审计。

### 10.2 runtime

- `createGatewayFromRoutes`：空路由返回 `undefined`、非法路由抛错、按给定顺序构造。
- `RoutingGateway`：选中模型优先、429/5xx 回退到下一个、非重试错误立即抛。
- `agent-loop`：
  - `selectedModel` 排首位；
  - `think` payload 携带实际模型。
- `server`：带 `modelRoutes` 的请求使用本次网关；不带时使用注入网关。

### 10.3 客户端与运营端

- 选择器：草稿态可选、已有会话锁定、运行中禁用、空列表禁用。
- 会话模型不可用时禁用发送并提示新建任务。
- 模型展示名映射与「已自动切换」标注。
- 事件渲染对缺失 `model` 的前向兼容。
- 运营端页面构建通过；关键交互（启用开关、默认星标、厂商删除保护）用组件测试或浏览器手工验证。

### 10.4 手工验收

1. 运营端新建两个厂商（至少一个真实 Key）、各建一个启用模型，设置默认。
2. 套餐勾选两个模型；客户端新建任务，选择非默认模型发送，确认运行使用所选模型。
3. 重新打开该会话，确认模型固定且不可切换；新建任务可另选。
4. 停用一个模型，确认客户端新任务不再展示；已固定该模型的会话发送提示新建任务。
5. 厂商返回 429 或 5xx（用本地桩）时，确认回退到下一个模型且消息标注「已自动切换」。
6. 删除全部模型与厂商记录，确认环境变量兜底仍可运行。
7. 检查接口、日志、浏览器网络面板中均无明文 Key。

## 11. 影响范围

| 层 | 文件 |
|---|---|
| 数据库 | `apps/bff/prisma/schema.prisma`、新迁移 |
| 共享 DTO | `packages/shared/src/dto.ts` |
| BFF 密钥 | 新增 `apps/bff/src/secrets/secret-box.ts`；改 `apps/bff/src/connector/crypto.ts`、`apps/bff/src/main.ts` |
| BFF 模型 | 新增 `apps/bff/src/models/{models.module,models.controller,model-catalog.service,env-providers,model.errors}.ts`；改 `admin/admin-models.{controller,service}.ts`、`billing/billing.service.ts`（`ModelPrice` → `ModelConfig` 访问器） |
| BFF 会话/任务 | 改 `sessions/sessions.{controller,service}.ts`、`tasks/tasks.controller.ts`、`app.module.ts` |
| runtime | 改 `model/create-gateway.ts`、`server.ts`、`agent-loop.ts` |
| 客户端 | 改 `apps/web/src/app/page.tsx`、`apps/web/src/lib/api.ts`；新增模型选择器组件与展示辅助 |
| 运营端 | 改 `apps/admin/src/app/(console)/models/page.tsx`、`plans/page.tsx`、管理端 API 封装 |
| 配置/部署 | `.env.example`、`.env.docker.example`、`scripts/deploy.sh`、`docs/deploy/06-deployment.md` |
