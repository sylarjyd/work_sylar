# AI 办公智能体 · 部署文档（Deployment Guide）

- 版本：v1.2
- 日期：2026-10-20
- 状态：随 M5b-2 可观测性交付更新
- 关联：`docs/design/02-architecture.md`、`docs/db/schema.sql`

> 本文覆盖**本地开发**与**生产部署**两套流程。当前代码已具备生产级安全边界，但生产化项（密钥托管、队列、CI/CD）见 §10 与开发计划 §6。

---

## 1. 部署拓扑

### 1.1 本地开发（单机三进程 + docker 依赖）

```mermaid
flowchart LR
    subgraph Dev["开发机"]
        WEB["web :3000"]
        BFF["bff :4000"]
        RT["runtime :4001"]
        PG[("Postgres :5432")]
        S3[("MinIO :9000/9001")]
        RD[("Redis :6379")]
    end
    Browser["浏览器"] --> WEB
    Browser -->|CORS| BFF
    BFF --> RT
    BFF --> PG
    BFF --> S3
    BFF --> RD
    RT --> S3
```

### 1.2 生产（推荐单机起步，可横向扩展）

```mermaid
flowchart LR
    U["用户浏览器"] -->|HTTPS| NG["Nginx / LB<br/>TLS 终止 · SSE 关闭缓冲"]
    NG -->|/api, /api/*/tasks(SSE)| BFF["bff (无状态, 可多实例)"]
    NG -->|/| WEB["web (Next.js)"]
    BFF -->|"HTTP+SSE (内网, 带 token)"| RT["runtime (内网, 绑内网地址+token)"]
    BFF --> PG[("Postgres 16")]
    BFF --> S3[("对象存储 S3/MinIO")]
    RT --> S3
    RT -->|模型 API| LLM["模型服务 (DeepSeek/兼容)"]
```

> runtime **绝不**直接暴露到公网；仅 BFF 经内网访问，且携带共享 token。

---

## 2. 前置条件

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22（实测 22.13.1） | 三个 Node 服务 |
| pnpm | 10.19.0 | 安装依赖（`corepack enable` 或全局安装） |
| Postgres | 16 | 元数据存储 |
| 对象存储 | MinIO 或云 S3 | 产物字节 |
| 反向代理 | Nginx / Caddy / 云 LB | TLS、SSE 支持 |
| 模型服务 | OpenAI 兼容（默认 DeepSeek） | 需 API Key |

---

## 3. 环境变量（全量）

复制 `.env.example` 为 `.env`（本地）。生产**不要用 `.env` 文件**，改用环境变量/密管系统注入。

| 变量 | 默认 | 生产建议 |
|---|---|---|
| `DATABASE_URL` | `postgresql://ai_office:ai_office@localhost:5432/ai_office?schema=public` | 强口令、内网地址、`sslmode` |
| `JWT_SECRET` | `change-me` | **强随机**（≥32 字节），密管注入 |
| `PORT` | `4000` | 按需 |
| `AGENT_RUNTIME_URL` | `http://localhost:4001` | 内网地址（多实例时指向 LB） |
| `AGENT_RUNTIME_HOST` | `127.0.0.1` | 生产设内网 IP 或 `0.0.0.0`（配合网络隔离） |
| `AGENT_RUNTIME_PORT` | `4001` | 按需 |
| `AGENT_RUNTIME_TOKEN` | 空 | **必须设置**（强随机），BFF 自动携带；未设置时 runtime 仅放行回环来源（fail-closed） |
| `DEEPSEEK_API_KEY` | 空 | 真实 key（空则走 Mock，不可用于生产） |
| `MODEL_BASE_URL` | `https://api.deepseek.com/v1` | 按模型服务 |
| `MODEL_NAME` | `deepseek-chat` | 按模型服务 |
| `TAVILY_API_KEY` | 空 | 建议设置（否则 DuckDuckGo 回退，质量较低） |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | 云 S3 端点或内网 MinIO |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `minioadmin` | **强凭证**，密管注入 |
| `S3_BUCKET` | `artifacts` | 按需 |
| `CONFIRM_TIMEOUT_MS` | `120000` | 确认等待上限，到点按拒绝兑现 |
| `CODE_EXEC_TIMEOUT_MS` | `5000` | 沙箱单次执行墙钟上限 |
| `CODE_EXEC_MAX_OLD_SPACE_MB` | `128` | 沙箱子进程堆上限 |
| `CODE_EXEC_MAX_OUTPUT_BYTES` | `65536` | 沙箱 stdout 累计截断阈值 |
| `NEXT_PUBLIC_BFF_URL` | `http://localhost:4000` | **构建期**注入（Next.js 公开变量），生产为对外 BFF 地址 |
| `EMBEDDING_BASE_URL` | `https://api.siliconflow.cn/v1` | 按嵌入服务端点 |
| `EMBEDDING_API_KEY` | 空 | 真实 key（空则走 Mock 嵌入，不可用于生产） |
| `EMBEDDING_MODEL` | `BAAI/bge-large-zh-v1.5` | 按嵌入服务模型 |
| `EMBEDDING_DIM` | `1024` | 须与 `KbChunk.vector` 列维度一致（当前 `vector(1024)`） |
| `BFF_INTERNAL_URL` | `http://localhost:4000` | runtime 访问 BFF 内部端点的内网地址 |
| `INTERNAL_TOKEN` | 空 | **非本机部署必设**（强随机）；空值仅放行回环来源 |
| `KB_CHUNK_SIZE` | `800` | 按文档类型与模型上下文调优 |
| `KB_CHUNK_OVERLAP` | `150` | 按切分效果调优 |
| `KB_MAX_FILE_BYTES` | `10485760` | 按业务与存储配额调整 |
| `CONNECTOR_ENC_KEY` | 空 | **必须设置**（32 字节 hex）；MCP Server 的 env 加解密密钥，缺失时 BFF 启动失败 |
| `MCP_HEARTBEAT_MS` | `30000` | MCP 子进程心跳间隔 |
| `MCP_BACKOFF_BASE_MS` / `MCP_BACKOFF_MAX_MS` | `1000` / `30000` | MCP 子进程崩溃退避重拉 |
| `MCP_INIT_TIMEOUT_MS` | `10000` | MCP `initialize` / 校验握手超时 |
| `MCP_CALL_TIMEOUT_MS` | `30000` | MCP 单次工具调用超时 |
| `LOG_LEVEL` | `info` | 日志级别；生产保持 `info`，排障临时调 `debug` |
| `LOG_PRETTY` | `0` | 本地开发设 `1`；生产关闭，避免彩色转义符进入日志采集 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空 | OTLP/HTTP 端点（如 `http://collector:4318`）；留空不导出 trace |
| `OTEL_EXPORTER_OTLP_HEADERS` | 空 | OTLP 请求头，逗号分隔 `key=urlencoded-value` |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | trace 采样率 0–1；高流量环境下调以控成本 |
| `METRICS_ROLLUP_MS` | `300000` | 指标聚合间隔，最小 10000；`0` 关闭定时任务；多实例由 Leader 锁保证只跑一个 |
| `METRICS_BACKFILL_HOURS` | `24` | 启动时回填小时数，1–168 |
| `METRICS_RETENTION_DAYS` | `90` | 指标桶保留天数，1–3650；到期由聚合任务分批清理 |
| `ALERT_RETENTION_DAYS` | `90` | 告警事件保留天数，1–3650；到期由聚合任务分批清理 |
| `ALERTS_ENABLED` | `true` | 告警评估总开关；也可在管理端参数页修改（DB 优先） |
| `ALERT_EVAL_MS` | `60000` | 评估间隔，最小 5000；`0` 关闭评估但仍会播种规则 |
| `ALERT_MAX_PER_HOUR` | `60` | Webhook 滚动一小时投递上限（含测试告警） |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_SECRET` | 空 | 初始 Webhook 配置；管理端写入的 DB 值优先，secret 仅以掩码展示 |
| `ADMIN_WEB_URL` | `http://localhost:3000` | 告警消息中的管理端跳转地址 |

> `JWT_SECRET` 未设置时 BFF 会抛错（fail-fast）；`AGENT_RUNTIME_TOKEN` 未设置时 runtime 仅放行回环来源（fail-closed）——生产两者都必须设置。

---

## 4. 构建与启动

### 4.1 构建

```bash
pnpm install --frozen-lockfile
pnpm build                 # turbo：按依赖顺序构建 shared → 各 app
```

产物：`packages/shared/dist`、`apps/agent-runtime/dist/server.js`、`apps/bff/dist/main.js`、`apps/web/.next`。

### 4.2 启动命令

| 单元 | 命令 | 说明 |
|---|---|---|
| shared | （构建产物，无独立进程） | — |
| agent-runtime | `pnpm --filter @ai-office/agent-runtime start` | `node dist/server.js`；启动时 `ensureBucket` 幂等建桶 |
| bff | `pnpm --filter @ai-office/bff start` | `node dist/main.js` |
| web | `pnpm --filter @ai-office/web start` | `next start -p 3000` |

> 生产用进程管理器（systemd / PM2 / Docker / K8s）托管，配置自动重启与日志收集。

---

## 5. 数据库

### 5.1 开发

```bash
pnpm --filter @ai-office/bff db:up      # docker compose 起 Postgres + MinIO + Redis
pnpm --filter @ai-office/bff db:push    # 用 Prisma schema 同步表结构（无迁移历史）
pnpm --filter @ai-office/bff db:generate
```

### 5.2 生产（推荐用迁移，而非 `db:push`）

`db:push` 适合开发快速迭代，**不适合生产**（无版本化、可能破坏性变更）。生产应：

1. 用 `prisma migrate dev` 生成迁移文件并提交（`apps/bff/prisma/migrations/`）。
2. 部署时执行：

```bash
pnpm --filter @ai-office/bff exec prisma migrate deploy
```

3. 或用 `docs/db/schema.sql` 作为基线手工建表（仅首次），后续仍走迁移。

> **首次建库**可用 `docs/db/schema.sql`：它把 Prisma 模型翻译为等价 DDL（Postgres）。

### 5.3 知识库（pgvector）

知识库 RAG 依赖 Postgres 的 **pgvector** 扩展做向量检索，部署时注意：

1. **镜像须带 pgvector**：本地 `db:up`/docker compose 已使用 `pgvector/pgvector:pg16`；生产 Postgres 必须是带 pgvector 扩展的镜像或安装该扩展的实例。
2. **启用扩展**：启动后须执行 `CREATE EXTENSION IF NOT EXISTS vector`（`prisma db push` 与 `docs/db/schema.sql` 均已包含；若手工建库须自行执行）。
3. **维度一致**：环境变量 `EMBEDDING_DIM` 必须等于 `KbChunk.vector` 列维度（当前 `vector(1024)`），二者不一致会导致写入/检索报错。
4. **内部端点鉴权**：`POST /internal/kb/search` 默认失败关闭——设了 `INTERNAL_TOKEN` 则校验共享密钥；未设则仅放行回环来源（`127.0.0.1`/`::1`）。runtime 与 bff 不同机部署时**必设**该变量，否则 runtime 请求将被 403 拒绝。

### 5.4 连接器 / MCP

- **密钥必设**：`CONNECTOR_ENC_KEY` 缺失时 BFF 启动即失败；轮换密钥会使既有连接器 env 无法解密，须同时重填。
- **子进程环境隔离**：runtime spawn MCP Server 时**不注入**本服务 `process.env`，仅传 SDK 白名单（`PATH`/`HOME` 等）+ 连接器自身 `env`，避免泄露 `DEEPSEEK_API_KEY`/`JWT_SECRET`。
- **权限**：连接器增删改仅租户管理员；`/connectors` 页对非管理员只读。注册路径一律创建 `member`，管理员由运维在账号注册后预置：`pnpm --filter @ai-office/bff admin:promote <email>`。
- **内网地址**：runtime 需能访问 `BFF_INTERNAL_URL`（默认 `http://localhost:4000`）拉连接器；跨机部署必设 `INTERNAL_TOKEN`。
- **隔离**：v1 不做命令白名单 / 沙箱，生产需按信任边界评估是否上容器隔离。
- **提示注入信任边界**：MCP Server 的工具描述与调用结果会进入模型上下文且未做净化；`permission:'confirm'`（工具调用前需人工确认）是主要缓解手段。仅接入可信的 MCP Server。
- **注册与角色**：注册不授予管理员，避免抢注邮箱提权；邮箱统一 trim + 小写后存储，注册与登录的查重均为大小写不敏感（兼容存量混合大小写账号）。
- **存量库注意**：`User.role` 列默认值已由 `admin` 改为 `member`。用旧版 `docs/db/schema.sql` 建库的实例须留意：既有默认值与新库不一致，同时既有用户的历史 `role` 不会自动变更，需按需手工校正。

---

## 6. 反向代理配置要点（Nginx 示例）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/ssl/fullchain.pem;
    ssl_certificate_key /etc/ssl/privkey.pem;

    # Web（Next.js）
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # BFF（REST + SSE）
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE 必备：关闭缓冲、保持长连接
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

**SSE 关键项**：`proxy_buffering off`（否则事件被缓冲、前端不实时）、`proxy_read_timeout` 调大（长任务）、`Connection ""`（保持 keep-alive）。

---

## 7. 健康检查与探活

| 单元 | 端点 | 鉴权 | 期望 |
|---|---|---|---|
| agent-runtime | `GET /health` | 无 | `200 {"ok":true}` |
| agent-runtime | `GET /metrics`、`GET /metrics/summary` | 回环或 `x-agent-runtime-token` | 前者 Prometheus 文本，后者 JSON 摘要 |
| bff | `GET /api/health` | 无 | `200 {"status":"ok","version":"…"}`，仅证明进程存活 |
| bff | `GET /api/health/ready` | 回环或 `x-internal-token` | DB/Redis/runtime 全部可用才 200；否则 503 且 `checks` 标出失败项 |
| bff | `GET /metrics` | 回环或 `x-internal-token` | Prometheus 文本 |
| web | `GET /` | 无 | 200 |

> 编排探针建议：liveness 打 `/api/health`，readiness 打 `/api/health/ready`（由内网探针携带 `x-internal-token`）。不要把 `/metrics` 或 `/api/health/ready` 暴露到公网。

---

## 8. 启动顺序

1. **基础设施**：Postgres、对象存储、Redis（M5a 限流，生产必配）。
2. **数据库迁移**：`prisma migrate deploy`（或首次执行 `docs/db/schema.sql`）。
3. **agent-runtime**：启动并确认 `ensureBucket` 成功、`/health` 返回 ok。
4. **bff**：启动（依赖 runtime 与 DB）。
5. **web**：启动（依赖 bff）。
6. **反向代理**：生效并对接 TLS。

> runtime 启动时若日志出现 `ensureBucket 失败`，说明对象存储未就绪，文档工具会在运行期报错——须先修好对象存储。

---

## 9. 扩容、升级与回滚

### 9.1 扩容

- BFF 无状态，可**多实例 + LB**；会话/队列态（规划）入 Redis 共享。
- runtime 无状态（运行态在请求内），可多实例，由 BFF 侧的 LB 分发 `AGENT_RUNTIME_URL`。
- CPU 密集（沙箱/文档生成）隔离到独立 worker/容器（M3/M5）。
- 瓶颈优先观察：模型 API 限流、DB 连接池、对象存储带宽。

### 9.2 升级

1. 构建新版本产物。
2. 先跑数据库迁移（向后兼容的前提下）。
3. 滚动重启 runtime → bff → web（按依赖逆序）。
4. 观察日志与关键指标。

### 9.3 回滚

- 应用层：切回上一版本产物并重启。
- 数据库：迁移**尽量设计为向后兼容**；必要时用备份恢复（见 §10）。

---

## 10. 备份、恢复与安全加固

### 10.1 备份

| 对象 | 方案 |
|---|---|
| Postgres | 定期逻辑备份（`pg_dump`）+ WAL 归档；定期**演练恢复** |
| 对象存储 | 桶版本控制/复制；生命周期策略（当前产物只增不减，M5 补策略） |
| 配置/密钥 | 密管系统管理，纳入备份与轮换流程 |

### 10.2 安全加固清单（生产必做）

- [ ] 轮换曾在开发中出现的模型 API Key（见开发计划 P2）。
- [ ] `JWT_SECRET`、`AGENT_RUNTIME_TOKEN`、S3/DB 凭证：强随机、密管注入、定期轮换。
- [ ] `AGENT_RUNTIME_HOST` 绑定内网；`AGENT_RUNTIME_TOKEN` 必设；runtime 不在公网暴露。
- [ ] CORS 收敛为生产域名白名单（当前 `origin: true`）。
- [ ] 全站 HTTPS；HSTS。
- [ ] 数据库仅内网可达、最小权限账号、连接加密。
- [ ] 对象存储桶**私有**（当前下载经 BFF 代理，桶不公开）。
- [ ] 容器镜像**钉版本/digest**（当前 MinIO 为 `:latest`，见开发计划 P3）。
- [ ] 补齐按 IP/全局滥用防护（RPM 限流与积分额度已在 M5a 落地；限流指标与告警已在 M5b-2 落地，P7）。
- [ ] 日志脱敏（M5b-2 已内置 redact 路径；新增业务日志仍需自查）。
- [ ] 为 BFF 的 `/api/health`、`/api/health/ready` 配置 liveness/readiness 探针（M5b-2 已提供）。
- [ ] `code.exec` 沙箱为「受限计算」而非强隔离：无 fs/网络/子进程已被 harness + Node 权限模型收口；若需更强隔离（防进程内 V8 漏洞），升级为容器沙箱。

---

## 11. Docker 参考（可选）

本地依赖（Postgres + MinIO + Redis，compose 文件位于 `apps/bff`）：

```bash
pnpm --filter @ai-office/bff db:up      # 等价于在 apps/bff 下执行 docker compose up -d
```

生产容器化建议（**要点**，非最终清单）：

- `web`/`bff`/`runtime` 各自构建镜像（多阶段构建，仅含产物与运行时依赖）。
- 镜像**钉 Node 基础镜像版本**；非 root 用户运行。
- 用 `docker compose` / K8s 编排；密钥走 secrets，不写进镜像。
- `NEXT_PUBLIC_BFF_URL` 在 web **构建期**注入。

> 仓库当前**未提供**生产 Dockerfile 与编排文件，为 M5 上线准备的待办项。

---

## 12. 已知生产风险速查

| 风险 | 处置 | 详见 |
|---|---|---|
| 密钥曾入库/公开 | 立即轮换 | 开发计划 P2 |
| `Artifact.version` 并发重号 | 加唯一约束 + 重试 | 开发计划 P1 |
| 镜像未钉版本 | 钉 digest | 开发计划 P3 |
| SDK 版本偏斜 | 统一版本 | 开发计划 P4 |
| CORS 未收敛 | 域名白名单 | 开发计划 P5 |
| 无 CI/CD、无覆盖率门槛 | 补 CI | 开发计划 P6 |
| 请求限流仅覆盖 RPM 与积分额度 | 限流指标与告警已随 M5b-2 落地；仍缺按 IP/全局滥用防护 | 开发计划 P7 |
| runtime 鉴权默认可选 | 生产强制 `AGENT_RUNTIME_TOKEN` + 网络隔离 | 开发计划 P8 |
| 无备份演练/生命周期 | 备份 + 演练 + S3 策略 | 开发计划 P9 |
| 长任务无队列/续传 | 队列化 + checkpoint | 开发计划 P10 |

---

## 13. M5a 计费与网关

### 13.1 依赖

- PostgreSQL（已有）、Redis（限流用，可选但生产必配）。
- `pnpm --filter @ai-office/bff db:up` 是初始化基础设施的第一步：该脚本实际执行 `docker compose up -d`，compose 文件位于 `apps/bff`，会启动 `pgvector/pgvector:pg16`、MinIO 与 `redis:7.4-alpine`。

### 13.2 初始化

```bash
pnpm --filter @ai-office/bff db:up            # 1. 起 Postgres + MinIO + Redis
pnpm --filter @ai-office/bff db:push          # 2. 同步表结构
pnpm --filter @ai-office/bff db:seed:billing  # 3. 写入套餐与模型价格
```

`db:seed:billing` 幂等写入 4 个套餐与模型价格；调价改该脚本后重跑即可。

初始化后验证（需 BFF 已启动，如 `pnpm dev` 或 `pnpm --filter @ai-office/bff start`）：

```bash
# 注册账号（已注册可跳过）
curl -s -X POST http://localhost:4000/api/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"demo@example.com","password":"demo-password"}'

# 登录并提取 token
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"demo@example.com","password":"demo-password"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")

# 预期 plan.id=free、balance=500、subscription.status=active
curl -s http://localhost:4000/api/billing/summary -H "authorization: Bearer $TOKEN"
```

### 13.3 关键环境变量

| 变量 | 说明 |
|---|---|
| `REDIS_URL` | 留空时使用进程内固定窗口限流（仅单实例）。已配置 Redis 但连接/命令失败时是 **fail-open（放行请求）** 并限频告警（10 秒最多一次），不会退化为内存限流。生产必须配 Redis 并为该告警建立监控；多实例不配 Redis 会各自独立计数，限流实际失效 |
| `MODEL_PROVIDERS` | runtime 多模型路由，JSON 数组声明模型、baseUrl、apiKeyEnv；未配置回退 `MODEL_BASE_URL` + `MODEL_NAME`。`DEEPSEEK_API_KEY` 为空时 runtime 走 mock 模型（仍产生 usage，可验证结算链路，但不可用于生产） |
| `BILLING_SWEEP_MS` | 补偿扫描间隔（毫秒），默认 60000；`<=0` 或非数字会**完全禁用**补偿扫描（不会夹到下限）。禁用后 pending 用量不会自动结算、预占不会释放、过期批次不会清理；**生产禁止设为 0** |

### 13.4 运营操作（管理员 JWT）

```bash
# 注册后先提权为管理员（沿用 13.2 注册的账号；已有管理员可跳过）
pnpm --filter @ai-office/bff admin:promote demo@example.com

# 登录获取 TOKEN：请求字段为 email/password，响应为 { token, user }
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"demo@example.com","password":"demo-password"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")

# 开通/续期付费套餐
curl -X POST http://localhost:4000/api/billing/admin/subscribe \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"planId":"standard"}'

# 发放/收回积分（负数收回）
curl -X POST http://localhost:4000/api/billing/admin/credits \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"amount":1000,"note":"活动赠送"}'
```

### 13.5 失败排查

- `insufficient_balance`：管理员收回积分超过可用余额。
- 运行 402 `insufficient_credits`：可用积分不足 1。
- 运行 429：超过套餐 RPM；响应头 `retry-after` 给出等待秒数。
- 日志出现 `Redis 限流器不可用，已放行请求`：限流处于 fail-open，请求未被限流；应尽快恢复 Redis 并对该告警建立监控。
- 结算失败：`UsageRecord` 保持 `pending`，`CreditHold` 保留。补偿扫描间隔默认 60s，且只处理创建超过 60s 的陈旧记录，最坏约 2 分钟完成补偿；补偿依赖 BFF 常驻运行，进程停止则补偿停止。

### 13.6 安全边界（生产必读）

- **BFF 是计费与预算的唯一裁决方**；runtime 信任 BFF 下发的 `billing` 参数，**runtime 不得直接暴露到公网**。
- **单机部署**：保持 `AGENT_RUNTIME_HOST=127.0.0.1`（默认值），runtime 只监听回环地址。
- **跨机部署**：设置 `AGENT_RUNTIME_HOST=<内网 IP>`，并在主机防火墙/安全组拒绝公网访问 4001 端口；BFF 经内网地址访问。
- **容器部署**：runtime 只加入内部网络，不把 4001 端口映射到宿主机公网。
- **共享 token**：生产必须设置 `AGENT_RUNTIME_TOKEN`（强随机），BFF 调用时自动携带 `x-agent-runtime-token` 头；未设置时 runtime 仅放行回环来源。
- 若 runtime 可被外部直接调用，调用方可伪造预算绕过计费；此项列入 M5c 上线准备。

---

## 管理端（M5b-1）

- 管理员预置：`pnpm --filter @ai-office/bff admin:promote <email>`；注册用户一律 `member`。
- 入口：以管理员登录后，工作台侧栏出现「管理后台」，路由前缀 `/admin`；普通用户直连 `/api/admin/*` 返回 403。
- 权限：所有管理接口位于 `/api/admin/*`，受 `JwtGuard + AdminGuard` 保护；`JwtGuard` 每次请求查库，禁用用户立即失效。
- 写操作非破坏性：用户仅可启用/禁用、改角色；会话仅可归档；套餐仅可停用；模型价格可删除但被启用套餐引用时拒绝。
- 审计：写操作与业务写入同事务落 `AdminAuditLog`；敏感查看（用户/租户/会话/消息/任务/运行详情）尽力记录；不记录消息正文、密钥与工具入参全文。
- 参数白名单：`maxRounds`、`confirmTimeoutMs`、`codeExecTimeoutMs`、`kbChunkSize`、`kbChunkOverlap`；来源优先级 DB > 环境变量 > 默认值，页面修改即时生效。

## 管理端（M5b-2 可观测性）

- 概览 `/admin/overview`：24h/7d/30d KPI、运行/Token/时长趋势、按模型堆叠积分、模型成本与三服务健康；60 秒静默刷新，标签页隐藏时暂停。
- 告警 `/admin/alerts`：规则就地编辑、事件状态筛选与分页、发送测试告警；测试与真实投递共用每小时配额。
- 时间线：任务页打开运行后自动加载，最多 500 个节点，超出时提示省略数量；不包含 prompt 与工具入参/结果正文。
- 所有管理端接口仍受 `JwtGuard + AdminGuard` 保护；写操作与审计同事务。

### 可观测数据流

1. 服务产生结构化日志/span/指标；日志经 redact 后输出，span 按 `OTEL_TRACES_SAMPLER_ARG` 采样并导出到 OTLP 端点。
2. BFF 定时把事件聚合进 `MetricBucket`（小时桶），概览、趋势与告警共用。
3. 告警评估读取服务健康、结算滞留、运行失败率/P95、模型错误率与积分窗口；条件满足时写 `AlertEvent`（`openKey` 唯一，避免重复触发），并按冷却时间投递 Webhook。
4. Webhook 请求带 `x-ai-office-signature: sha256=<HMAC-SHA256(body, secret)>`，5 秒超时、不跟随重定向、仅允许 http(s)，最多重试 3 次。
5. 条件恢复后自动写 resolved 事件；停用规则会在同一事务里关闭其未恢复事件。

投递失败只影响通知，不阻塞评估；事件与 `deliveryStatus/deliveryError` 保留在告警中心。

### 安全边界（生产必读）

- **禁止把 prompt、消息正文、工具入参/结果全文、Authorization、内部 token、API key、连接器 env、Webhook secret 写入日志或指标 label。**
- **指标 label 禁止 userId/tenantId/sessionId/runId**；管理端指标接口也不返回邮箱、消息内容、工具入参/结果。
- `/metrics`、`/api/health/ready` 仅回环或内部 token 可访问；runtime 指标端点仅在配置 `AGENT_RUNTIME_TOKEN` 后对非回环来源放行。
- Webhook URL 仅管理员可改；secret 设置后永不返回明文，读取一律掩码。
- 日志默认带 `traceId/spanId/requestId` 与脱敏后的 userId/tenantId，排障时优先用 `requestId` 串联，不要把业务正文补进日志。
- 指标与告警历史默认各保留 90 天，分别按 `METRICS_RETENTION_DAYS`、`ALERT_RETENTION_DAYS` 分批清理；需要长期留存时在 Prometheus/远端存储侧另行配置。
