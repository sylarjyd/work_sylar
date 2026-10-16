# AI 办公智能体 · 部署文档（Deployment Guide）

- 版本：v1.0
- 日期：2026-10-16
- 状态：随 M2 交付更新
- 关联：`docs/design/02-architecture.md`、`docs/db/schema.sql`

> 本文覆盖**本地开发**与**生产部署**两套流程。当前代码已具备生产级安全边界，但生产化项（密钥托管、队列、可观测、CI/CD）见 §10 与开发计划 §6。

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
    end
    Browser["浏览器"] --> WEB
    Browser -->|CORS| BFF
    BFF --> RT
    BFF --> PG
    BFF --> S3
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
| `AGENT_RUNTIME_TOKEN` | 空 | **必须设置**（强随机），BFF 自动携带 |
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
| `INTERNAL_TOKEN` | 空 | **必须设置**（强随机），非本机部署必设 |
| `KB_CHUNK_SIZE` | `800` | 按文档类型与模型上下文调优 |
| `KB_CHUNK_OVERLAP` | `150` | 按切分效果调优 |
| `KB_MAX_FILE_BYTES` | `10485760` | 按业务与存储配额调整 |

> `JWT_SECRET` 未设置时 BFF 会抛错（fail-fast）；`AGENT_RUNTIME_TOKEN` 未设置时 runtime 仅靠绑本机限制可达面——生产两者都必须设置。

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
pnpm --filter @ai-office/bff db:up      # docker compose 起 Postgres + MinIO
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
4. **内部端点鉴权**：非本机部署时 `INTERNAL_TOKEN` **必设**——runtime 经该共享密钥调用 BFF 内部检索端点 `POST /internal/kb/search`；空值仅在本地开发允许（不校验）。

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

| 单元 | 端点 | 期望 |
|---|---|---|
| agent-runtime | `GET /health` | `200 {"ok":true}` |
| bff | 无专用健康端点（见 §10 建议补充） | 可用 `GET /api/sessions`（无 token 应 401，证明服务在） |
| web | `GET /` | 200 |

> 建议为 BFF 增加 `GET /health`（含 DB 连通性检查），并在编排中配置 liveness/readiness 探针（见 §10）。

---

## 8. 启动顺序

1. **基础设施**：Postgres、对象存储（+ Redis，若 M5 引入）。
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
- [ ] 加请求限流与租户配额（P7）。
- [ ] 日志脱敏（不记录令牌、密码、密钥）。
- [ ] 为 BFF 增加 `/health` 并配置探针。
- [ ] `code.exec` 沙箱为「受限计算」而非强隔离：无 fs/网络/子进程已被 harness + Node 权限模型收口；若需更强隔离（防进程内 V8 漏洞），升级为容器沙箱。

---

## 11. Docker 参考（可选）

本地依赖（数据库 + 对象存储）：

```bash
pnpm --filter @ai-office/bff db:up      # 等价于在 apps/bff 下 docker compose up -d
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
| 无限流/配额 | 网关 + 租户配额 | 开发计划 P7 |
| runtime 无内置鉴权 | 强制 token + 网络隔离 | 开发计划 P8 |
| 无备份演练/生命周期 | 备份 + 演练 + S3 策略 | 开发计划 P9 |
| 长任务无队列/续传 | 队列化 + checkpoint | 开发计划 P10 |
