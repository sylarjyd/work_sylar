# M4a「知识库 RAG」· 上传解析嵌入 + 向量检索问答 · 设计文档

- 日期：2026-10-16
- 状态：待用户审阅
- 关联：上游 `docs/superpowers/specs/2026-10-15-ai-office-agent-design.md` 第 4.1 / 5.2 / 6 / 7 节
- 前置：M3（权限 + 确认卡片 + 代码沙箱）已交付并端到端验证
- 说明：M4「扩展」含两个独立子系统，拆为 **M4a 知识库 RAG**（本文档）与 **M4b 连接器/MCP**（另起 spec）。本文档只覆盖 M4a。

## 1. 背景与目标

上游 §6 把「知识库（RAG）」列为网页端 v1 功能：「上传 → 解析/切分/向量化 → 检索问答；来源引用」。有了它，Agent 才能基于**用户私有文档**作答——这是「会干活」迈向「干对活」的关键一环。M4a 交付这条闭环。

**目标**
- **上传即入知识库**：支持 `txt/md/docx/pdf/xlsx/csv`，解析为文本。
- **摄取管线**：解析 → 切分 → 向量化 → 落库（异步，状态可查）。
- **检索问答**：新增内置工具 `kb.retrieve`，模型按需检索用户知识库；结果带**来源引用**（文件名 + 切片序号）。
- **网页端**：`/kb` 页管理知识库（上传 / 列表 / 删除）；工作台渲染 `kb.retrieve` 的来源引用。
- 沿用 M1–M3 的三层解耦、SSE 契约、权限模型（`kb.retrieve` 为 `safe`）。

**非目标（本期明确不做）**
- **多库 / 库级权限 / 会话挂载**：v1 每用户一个库（`tenant_id + user_id` 即库）。
- **重排序（rerank）、混合检索（BM25）、查询改写**：v1 纯向量 top-K 余弦。
- **增量重索引 / 版本**：改文件 = 重新上传。
- **来源定位到页/段落**：v1 引用粒度到「切片序号」，不做 PDF 页坐标高亮。
- **MCP 外部工具**：属 M4b。
- **向量库水平扩展 / 分库分表**：单 PG + pgvector，量级到十万级切片再议。

## 2. 已确认的关键决策

| 议题 | 决策 | 理由 |
|---|---|---|
| 范围边界 | 仅「上传→解析→切分→嵌入→存储→检索引用」闭环 | 上游 v1 功能清单；MCP 属 M4b |
| 嵌入模型 | OpenAI 兼容 `/embeddings`（`EmbeddingGateway` 接口 + compat 实现 + 确定性 mock） | 与现有 `ModelGateway`/`MockGateway` 模式一致；无 key 亦可测 |
| 库作用域 | 每用户一个库（`tenant_id + user_id`） | schema/UI/检索过滤最简，v1 够用 |
| 文件类型 | `txt/md/docx/pdf/xlsx/csv` | 覆盖主要知识文档形态 |
| **计算/数据边界** | **BFF 拥有 DB 与向量检索；runtime 拥有解析与嵌入** | 维持现有「BFF 独占 PG、runtime 无状态」边界；CPU 密集（解析/嵌入）留在 runtime（§7.3） |
| 向量存储 | **pgvector**（`vector(1024)` 列 + HNSW `vector_cosine_ops`） | 上游 §4.1 原定；库侧检索可扩展 |
| 摄取时机 | **异步 + 轮询**（上传返回 202 `pending`，后台摄取，前端轮询状态） | 大 PDF 不阻塞上传请求 |
| 引用粒度 | 切片序号（文件名 `#seq`） | v1 简，够模型引用 |

## 3. 架构与数据流

### 3.1 分层变更

- **shared**：新增 `KbDocDto`（`{ id, filename, mime, size, status, chunkCount, error, createdAt }`）、`KbSearchHit`（`{ docName, seq, score, text }`）类型，供 BFF/web 复用。另 `RunRequest` 增加 `userId`（BFF 从 JWT 的 `sub` 透传）：检索需按 `tenant_id + user_id` 过滤，而 runtime 只做嵌入、不知道用户身份（M3 仅透传了 `tenantId`）。
- **agent-runtime**：
  - 新增 `embedding/`：`types.ts`（`EmbeddingGateway { embed(texts: string[]): Promise<number[][]> }`）、`openai-compat-embedding.ts`、`mock-embedding.ts`、`create-embedding-gateway.ts`。
  - 新增 `kb/`：`parse.ts`（按类型抽文本）、`chunk.ts`（滑窗切分）、`ingest.ts`（编排）、`bff-client.ts`（调 BFF 内部检索端点）。
  - 新增 `tools/kb-retrieve.ts`（`permission: 'safe'`）。
  - `tools/types.ts`：`RunContext` 增加 `userId`（来源同 `RunRequest`）。
  - `agent-loop.ts`：`tool_result` 事件新增 `display` 字段**原样透传**（工具结果里的 `display` 不做 500 字截断，供 web 渲染来源列表；`preview` 仍截断）。
  - `server.ts`：新增 `POST /kb/ingest`（复用 M3 的 `authorized()` 校验 `x-agent-runtime-token`）。
  - `tools/registry.ts`：注册 `kb.retrieve`（工具数 6 → 7）。
- **bff**：
  - Prisma 新增 `KbDoc` / `KbChunk`；`KbChunk.vector` 为 `Unsupported("vector(1024)")`（Prisma 无法原生建模，见 §4.3）。
  - 新增 `kb/`：`kb.service.ts`（上传/列表/删除/摄取编排/向量检索）、`kb.controller.ts`（对外 JWT 路由 + 内部 token 路由）、`kb.module.ts`、`storage.ts`（KB 对象写入，ARTIFACT_STORAGE 仅只读）。
  - `main.ts`：注册 `@fastify/multipart`（新增依赖）以解析上传。
  - `app.module.ts` 注册 `KbModule`。
- **web**：新增 `/kb` 页（上传/列表/删除/轮询）；`lib/api.ts` 增 `listKbDocs` / `uploadKbDoc` / `deleteKbDoc`；工作台 `render-step` 识别 `kb.retrieve` 结果渲染来源引用。
- **基础设施**：Postgres 镜像由 `postgres:16-alpine` 换为 `pgvector/pgvector:pg16`（drop-in，含扩展）；`schema.sql` 增 `CREATE EXTENSION vector`、两张表、HNSW 索引。

### 3.2 上传摄取流（异步）

```
Web                 BFF                          Runtime
 | POST /api/kb/docs (multipart) ─▶ 校验类型/大小
 |                                  存 S3 (storage_key)
 |                                  建 KbDoc(status=pending) ── 202 {doc}
 |  [前端轮询 GET /api/kb/docs]      └─(后台)─ POST /kb/ingest{storageKey,filename,mime} ─▶
 |                                                      从 S3 取对象 → parse → chunk → embed
 |                                  ◀─ {ok, chunks:[{seq,text,vector}]} ──────────────
 |                                  写 KbChunk(向量, 原始 SQL) → KbDoc(status=ready,chunkCount)
 |  ◀─ 列表显示 ready/failed ────────（失败写 status=failed + error）
```

### 3.3 检索问答流

```
Agent loop ── 模型决定调 kb.retrieve({query,topK})
   │  runtime 本地 embed(query) → 向量 v
   │  POST {BFF_INTERNAL_URL}/internal/kb/search  (header: x-internal-token)  {vector:v, topK, tenantId, userId}
   │  BFF: SELECT … ORDER BY vector <=> v LIMIT topK（按 tenant_id+user_id 过滤）
   │  ◀─ [{docName,seq,score,text}]
   └─ 组装带引用的文本 → 回填 tool_result → 模型据此作答
```

**边界不变式**：runtime 不连 Postgres。所有库读写、向量检索由 BFF 承担；runtime 只做「解析 + 嵌入 + 调用 BFF」。

## 4. 数据模型

### 4.1 表

```
KbDoc:   id(uuid) tenant_id user_id filename mime size storage_key
         status(pending|ready|failed) chunk_count error? created_at
KbChunk: id(uuid) doc_id tenant_id user_id seq text vector vector(1024) created_at
```
- 归属：两表均带 `tenant_id + user_id`，检索/删除一律按二者过滤（沿用 M1 行级隔离做法）。
- 级联：删 doc 级联删 chunk（`onDelete: Cascade`）。

### 4.2 pgvector 基础设施
- `CREATE EXTENSION IF NOT EXISTS vector;`（镜像换 `pgvector/pgvector:pg16` 后自带扩展）。
- 索引：`CREATE INDEX kb_chunk_vec_idx ON "KbChunk" USING hnsw (vector vector_cosine_ops);`
- 维度固定 **1024**（pgvector 索引要求定长）。换嵌入模型需同步改列维度（一行 SQL）+ `EMBEDDING_DIM`，文档在 §9 记录。

### 4.3 Prisma 建模的约束
`vector` 列用 `Unsupported("vector(1024)")` 声明。**Prisma Client 无法对含必填 `Unsupported` 字段的模型执行 `create()`/`update()`**——因此 `KbChunk` 的**写入与向量读取走 `$executeRaw`/`$queryRaw`**（向量字面量 `'[0.1,…]'`）；其余字段查询（列表、计数、删）用 Prisma 常规 API。

## 5. 接口契约

### 5.1 BFF 对外（`@UseGuards(JwtGuard)`）
| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/api/kb/docs` | multipart `file` | `202 {doc}`；类型不支持 `400 unsupported_type`；超限 `413 file_too_large` |
| GET | `/api/kb/docs` | — | `200 [KbDocDto]`（本人） |
| DELETE | `/api/kb/docs/:id` | — | `204`；非本人 `404 doc_not_found`（不泄露存在性） |

### 5.2 BFF 内部（`x-internal-token`）
| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/internal/kb/search` | `{ vector:number[], topK:number, tenantId:string, userId:string }` | `200 [{docName,seq,score,text}]`；token 不符 `401` |

### 5.3 runtime（`x-agent-runtime-token`，复用 M3 `authorized()`）
| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/kb/ingest` | `{ storageKey, filename, mime }` | `200 {ok:true, chunks:[{seq,text,vector}]}` 或 `{ok:false, error}` |

### 5.4 工具 `kb.retrieve`
- 名称 `kb.retrieve`，`permission: 'safe'`。
- 参数 schema：`{ query: string, topK?: number }`。
- 行为：clamp `topK` 至 `[1,20]`（默认 5）→ `embed(query)` → 调 `/internal/kb/search`。
- **工具结果结构**（供 agent-loop 回填 `tool_result` 与 web 渲染）：
  ```
  { ok: true, tool: 'kb.retrieve',
    text: '[来源: {docName}#{seq}] …',                    // 回给模型读的引用正文
    display: { sources: [{ docName, seq, score, snippet }] } }  // 供 web 渲染
  ```
  **`display` 由 agent-loop 原样透传**（不受 500 字 `preview` 截断影响；snippet 取切片前 200 字，避免 step 落库过大）。
  无命中：`{ ok:true, tool:'kb.retrieve', text:'知识库无匹配内容', display:{ sources:[] } }`；
  检索不可达：`{ ok:false, tool:'kb.retrieve', error:'kb_search_unreachable', text:'知识库暂时不可用', display:{ sources:[] } }`。
- web 由 `display.sources` 渲染来源列表；`text` 回给模型。

## 6. 切分与检索

- **切分**：字符滑窗，`KB_CHUNK_SIZE=800` / `KB_CHUNK_OVERLAP=150`（env 可调）。切前归一化空白；优先在换行边界断开（就近回退，避免切碎行）。v1 不引 tokenizer。
- **检索**：相似度 `1 - (vector <=> q)`（余弦）。`topK` clamp 1..20、默认 5。v1 不设相似度阈值，返回 top-K 交模型判断。
- **mock 嵌入**（无 key / 测试用）：按**词袋哈希**生成 1024 维归一化向量（分词按空白与标点粗切），使**词面重叠**驱动相似度——从而离线也能验证「上传→检索命中」的管线，而非返回无意义向量。
- **embedding 网关选择**：`EMBEDDING_API_KEY` 存在 → OpenAI 兼容实现；否则 → mock（与 `createGateway` 同构）。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 类型不在白名单 / 超过 `KB_MAX_FILE_BYTES` | 上传端点 `400 unsupported_type` / `413 file_too_large`，不建 doc |
| 解析出空文本 | `status=failed, error='empty_document'` |
| 解析或嵌入失败（含 provider 不可达） | `status=failed` + error 落库（异步，前端轮询可见） |
| 检索时 BFF 不可达 / 非 2xx | 工具回 `{ok:false, error:'kb_search_unreachable'}`，**不中断** agent loop |
| 检索无命中 | 工具回「知识库无匹配内容」，模型据此作答 |
| 删除：S3 对象删失败 | 仅记日志，不回滚 DB 删除 |
| `EMBEDDING_DIM` 与列维度不符 | 启动/插入即报错，文档要求二者一致（§9） |

## 8. Web UI

- **`/kb` 页**：文件选择 + 上传按钮；列表（文件名 · 状态徽标[`pending`/`ready`/`failed`+error] · 切片数 · 时间 · 删除）；存在 `pending` 项时按 2–3s 间隔轮询刷新，全部落定后停止。
- **工作台**：`kb.retrieve` 的 `tool_result` 渲染为**来源列表**（`文件名#seq` + score + 片段），读 `payload.display.sources`，扩展 `render-step.ts`；`kb.retrieve` 与既有工具共用 `tool_call`/`tool_result` step 类型，无需新 `StepType`。

## 9. 配置项

**runtime**
| 变量 | 默认 | 说明 |
|---|---|---|
| `EMBEDDING_BASE_URL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容嵌入端点 |
| `EMBEDDING_API_KEY` | 空 | 空则用 mock |
| `EMBEDDING_MODEL` | `BAAI/bge-large-zh-v1.5` | 需与 `EMBEDDING_DIM` 匹配 |
| `EMBEDDING_DIM` | `1024` | 必须等于 `KbChunk.vector` 列维度 |
| `BFF_INTERNAL_URL` | `http://localhost:4000` | runtime 调 BFF 检索的地址 |
| `INTERNAL_TOKEN` | 空 | runtime→BFF 内部端点校验（空则仅放行回环来源，非本机部署必设） |
| `KB_CHUNK_SIZE` / `KB_CHUNK_OVERLAP` | `800` / `150` | 切分参数 |

**bff**
| 变量 | 默认 | 说明 |
|---|---|---|
| `INTERNAL_TOKEN` | 空 | `/internal/kb/search` 校验（与 runtime 同值；空则仅放行回环来源） |
| `KB_MAX_FILE_BYTES` | `10485760` | 上传大小上限 |
| `AGENT_RUNTIME_URL` / `AGENT_RUNTIME_TOKEN` | 复用 M3 | 调 runtime `/kb/ingest` |

同步更新：`.env.example`、`turbo.json` `globalPassThroughEnv`、`docs/db/schema.sql`、`docs/deploy/06-deployment.md`、`README.md`。

## 10. 测试策略

- **runtime**
  - `embedding`：openai-compat 请求体断言（model/input）；mock 确定性 + 1024 维 + 词面重叠单调性。
  - `parse`：各类型 fixture（含空文档、损坏输入）→ 文本/异常。
  - `chunk`：窗口大小、重叠、换行边界回退、空/短文本。
  - `ingest`：编排（打桩 embed + S3）→ chunks 形状与 seq 连续。
  - `kb-retrieve` 工具：打桩 BFF fetch（命中/空/不可达），断言引用文本与 `topK` clamp；`registry` 计入 7 个工具。
- **bff**
  - `kb.service`：向量 SQL 与 `tenant_id+user_id` 过滤（打桩 prisma `$queryRaw`）、上传校验、状态流转、删除级联。
  - `kb.controller`：上传 400/413、列表、删除 404 归属、内部端点 token 401/透传。
- **web**：纯函数（状态徽标、引用渲染）vitest。
- **端到端**：上传一个 docx → 轮询至 `ready` → 提问命中内容 → 工作台显示来源引用。**需真实 `EMBEDDING_API_KEY` 才能验证语义质量**；无 key 时用 mock 仅验证管线（上传→切片→检索通路与引用渲染）。

## 11. 未决取舍（记入 backlog）

- **异步摄取无队列**：进程重启会遗留 `pending` doc。正解是 M5 的 Redis 队列（与 P10 续跑同批）。
- **`pdf-parse` 集成风险**：其历史版本在 ESM 下有 `module.parent` 探测副作用；实现若受阻则改用 `pdfjs-dist` 直接调用（属实现细节，计划阶段定）。
- **维度耦合**：`EMBEDDING_DIM` 与列维度需人工保持一致；将来可改为按模型分列/分表。
- **无 rerank**：top-K 纯向量，长文档召回质量有限；rerank/混合检索留待有真实评测集时再上。
