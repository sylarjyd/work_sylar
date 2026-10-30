# AI 办公智能体（对标 WorkBuddy）

多租户 AI Agent 平台：面向个人与团队的智能办公工作台 + 独立运营平台。
从对话、联网检索、文档生成、知识库问答，到连接器（MCP）、技能市场、专家助手、
按量计费与可观测性，整套链路开箱可跑。

> **许可提示**：本项目采用「源码可见」许可——**个人学习与非商业用途免费，商业使用需
> 取得书面授权**。详见 [LICENSE](./LICENSE) 与 [商业授权说明](./LICENSE-COMMERCIAL.md)。

---

## 目录

- [核心能力](#核心能力)
- [技术栈](#技术栈)
- [架构](#架构)
- [快速开始](#快速开始)
- [关键配置](#关键配置)
- [常用命令](#常用命令)
- [测试与质量](#测试与质量)
- [容器化部署](#容器化部署)
- [目录结构](#目录结构)
- [文档索引](#文档索引)
- [许可与商业授权](#许可与商业授权)

---

## 核心能力

### 客户端工作台（`apps/web`，3000）

| 能力 | 说明 |
| --- | --- |
| 对话与任务 | 流式输出、任务分类（对话/办公/开发）、排队位次、取消、断线续流 |
| 专家助手 | 内置公共助手 + 自建助手；绑定工具、技能、技能市场技能、连接器、知识库与默认模型 |
| 技能市场 | Agent Skills 规范：`SKILL.md` + 可选包内文件，支持 zip 批量上传、目录树浏览、在线测试与对话沉淀 |
| 知识库 | 上传文档 → 向量检索（pgvector）→ 回答带来源引用 |
| 连接器 | 接入外部 MCP Server（stdio），发现其工具并纳入 Agent 工具箱 |
| 成果与预览 | docx/xlsx/pptx/pdf/图片/音视频在线预览；成果面板可拖宽、点击文件直接预览 |
| 数据图表 | `chart.render` 产出规格，前端用 ECharts 渲染，随步骤落库可回放 |
| 套餐订阅 | 套餐、积分余额、流水与按日/模型用量 |

### 运营平台（`apps/admin`，3001，独立部署）

- 用户 / 会员 / 套餐 / 会话 / 任务与运行 / 问答缓存
- 模型厂商与模型配置：内置 13 家常用厂商预设，可调 `/models` 自动拉取模型列表
- 专家助手、技能市场：公共资源可维护，用户个人资源只读可审计
- 知识库管理、附件预览、参数配置、审计日志
- 运行概览看板与告警中心（告警规则、冷却、Webhook 投递）

### 平台能力

- **Agent Loop**：真模型驱动（plan → act → observe），工具按 `safe` / `confirm` / `blocked`
  三级权限执行，`confirm` 级工具下发内联确认卡片
- **多模型路由**：按厂商/模型配置路由，429/5xx 自动 fallback；RPM 限流与积分预占结算
- **任务队列**：BullMQ + Redis（可退化为进程内联），租户/实例并发控制、手动重试、
  `step` 断点续跑
- **可观测**：pino 结构化日志（敏感字段脱敏）、OTel 全链路 trace、Prometheus `/metrics`
- **多租户隔离**：所有查询带 `tenantId`，越权一律 404

---

## 技术栈

- **语言**：TypeScript 5.6（strict）
- **前端**：Next.js 15 + React 19 + Ant Design 5（客户工作台与运营端均为独立应用）
- **服务端**：NestJS 10 + Fastify
- **数据**：PostgreSQL 16 + pgvector、Prisma 6、Redis（BullMQ）、MinIO / S3
- **工程**：pnpm 10 + Turborepo、Vitest 2
- **可观测**：pino、OpenTelemetry、prom-client

---

## 架构

```
                    ┌────────────────────┐        ┌────────────────────┐
                    │  web 客户工作台     │        │  admin 运营平台     │
                    │  Next.js :3000     │        │  Next.js :3001     │
                    └─────────┬──────────┘        └─────────┬──────────┘
                              │  HTTP / SSE                  │
                              ▼                              ▼
                    ┌──────────────────────────────────────────────┐
                    │  bff 应用服务（NestJS + Fastify） :4000        │
                    │  认证/会话/任务/附件/成果/知识库/连接器/计费    │
                    │  管理端接口、SSE 网关、运行队列 worker         │
                    └───────┬───────────────────────┬──────────────┘
                            │ 内部 HTTP（token）     │ Prisma
                            ▼                       ▼
              ┌───────────────────────┐   ┌──────────────────────────┐
              │ agent-runtime :4001   │   │ PostgreSQL 16 + pgvector │
              │ Agent Loop / 工具网关  │   │ Redis（队列/限流）        │
              │ 模型 / 文档 / 代码沙箱 │   │ MinIO（产物与附件）       │
              └───────────────────────┘   └──────────────────────────┘
```

- `agent-runtime` 默认只监听 `127.0.0.1`，BFF 通过 `AGENT_RUNTIME_TOKEN` 访问；
  未配 token 时 fail-closed，仅放行回环来源。
- runtime 不直连数据库：知识库检索、技能包读取、产物落库都走 BFF 内部端点。

---

## 快速开始

### 前置要求

- **Node.js ≥ 22**（推荐 24）、**pnpm 10**
- **Docker**（本地 Postgres / Redis / MinIO；也可用已有实例改 `.env`）
- 一个可用的模型 API Key（缺省时 Agent 走确定性 Mock，链路仍可验证）

### 1. 安装与配置

```bash
pnpm install
cp .env.example .env
```

`.env` 至少需要：

- `JWT_SECRET`：换成随机值
- `DEEPSEEK_API_KEY`：真实模型调用（留空则走 Mock）
- `CONNECTOR_ENC_KEY` / `MODEL_ENC_KEY`：32 字节 hex（连接器与厂商密钥的加密密钥）
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- 知识库需要 `EMBEDDING_API_KEY`（默认硅基流动 bge-large-zh，`EMBEDDING_DIM=1024`）

### 2. 基础设施

```bash
pnpm --filter @ai-office/bff db:up     # Postgres / MinIO / Redis（docker compose）
pnpm --filter @ai-office/bff db:push   # 同步表结构 + 应用中文注释
```

> Prisma CLI 读取的是 `apps/bff/.env`，不是仓库根 `.env`。若 `db:push` 报缺少
> `DATABASE_URL`，把根 `.env` 的同名变量复制到 `apps/bff/.env`，或在执行前导出该变量。

`db:push` 会同时校验表/字段的中文注释是否完整，以及 `docs/db/schema.sql` 基线是否同步。

### 3. 启动

```bash
pnpm dev
```

一次拉起 `web(3000)`、`admin(3001)`、`bff(4000)`、`agent-runtime(4001)`。

> 若 `pnpm dev` 未拉起 runtime（4001 未监听，工作台会提示运行时不可用），单独启动：
> `pnpm --filter @ai-office/agent-runtime dev`。

访问：

| 服务 | 地址 |
| --- | --- |
| 客户工作台 | http://localhost:3000 |
| 运营平台 | http://localhost:3001（仅管理员账号） |
| BFF 健康检查 | http://localhost:4000/api/health/ready |

首次使用在登录页注册账号即可；运营端需要管理员角色（`apps/bff/scripts/promote-admin.mjs`）。

### 4. 文件预览资源（可选）

```bash
pnpm assets:viewer   # 生成预览 Worker/WASM，约 190MB × 2，已 gitignore
```

未生成时预览会失败，但下载可用；Docker 构建阶段会自动生成。

---

## 关键配置

完整清单见 `.env.example`，常用项：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（需启用 pgvector 扩展） |
| `REDIS_URL` | 队列与限流；留空时退化为进程内联执行 |
| `JWT_SECRET` | 用户 JWT 签名密钥 |
| `DEEPSEEK_API_KEY` / `MODEL_*` | 默认模型与厂商配置；多模型用 `MODEL_PROVIDERS` JSON |
| `EMBEDDING_*` | 知识库嵌入服务（地址/密钥/模型/维度） |
| `S3_*` | 对象存储端点、密钥与桶（runtime 启动时幂等建桶） |
| `AGENT_RUNTIME_URL` / `AGENT_RUNTIME_TOKEN` | BFF → runtime 地址与共享密钥（fail-closed） |
| `BFF_INTERNAL_URL` / `INTERNAL_TOKEN` | runtime → BFF 内部端点（知识库、技能包） |
| `CONNECTOR_ENC_KEY` / `MODEL_ENC_KEY` | 连接器 env、厂商 API Key 的 AES-256-GCM 密钥 |
| `RUN_QUEUE_ENABLED` / `RUN_QUEUE_*` | 队列开关、并发、每租户并发与上限 |
| `NEXT_PUBLIC_BFF_URL` / `NEXT_PUBLIC_ADMIN_URL` | Web 构建期：BFF 与运营端地址 |
| `ADMIN_BFF_URL` | 运营端构建期 BFF 地址 |

> 构建期变量（`NEXT_PUBLIC_*`、`ADMIN_BFF_URL`）修改后必须重新构建前端镜像/产物。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式启动全部服务 |
| `pnpm build` | 全量构建 |
| `pnpm test` | 全量测试（Turbo 并行） |
| `pnpm --filter @ai-office/web dev` | 只启动客户工作台 |
| `pnpm --filter @ai-office/agent-runtime dev` | 单独启动 Agent 运行时 |
| `pnpm --filter @ai-office/bff db:up` | 启动本地基础设施容器 |
| `pnpm --filter @ai-office/bff db:push` | 同步表结构并校验注释/基线 |
| `pnpm --filter @ai-office/bff db:comments:check` | 只校验中文注释完整性 |
| `pnpm assets:viewer` | 生成文件预览静态资源 |

---

## 测试与质量

```bash
pnpm test      # 全量单测
pnpm build     # 类型检查 + 产物构建（含 Next.js 生产构建）
```

仓库约定（见 `AGENTS.md`）：

- **数据库表与字段必须有中文注释**（`apps/bff/prisma/comments.sql` 为唯一来源），
  `db:push` 会强制校验；
- 所有查询带 `tenantId` 并逐查询校验归属，越权返回 404；
- 跨层类型只定义在 `packages/shared`；改完先 `pnpm --filter @ai-office/shared build`；
- 提交信息格式：`type(scope): 中文摘要`，正文说明「为什么改」。

Windows 下若 Turbo 测试因临时目录权限失败，可把 `TMP`/`TEMP` 指到仓库内目录再执行。

---

## 容器化部署

需要 Docker（含 Compose）。`deploy.sh`（Windows 用 `deploy.cmd`）：

```bash
./deploy.sh                  # 构建并启动客户端栈
./deploy.sh --with-admin     # 同机额外启动运营端（默认仅绑定 127.0.0.1）
./deploy.sh --admin-only     # 只部署运营端（独立内网主机）
./deploy.sh --no-build       # 复用已有镜像
./deploy.sh --logs           # 跟随日志
./deploy.sh --down           # 停止容器（保留数据卷）
./deploy.sh --down --purge   # 停止并清空数据卷
```

- 首次运行基于 `.env.docker.example` 生成 `.env.docker`（含随机密钥，已被 gitignore）。
- 服务：`web`、`bff`、`agent-runtime`（仅容器内网）、Postgres/MinIO/Redis，以及一次性
  `db-init`（建 vector 扩展、同步表结构、写计费种子）。
- 端口与地址：`WEB_PORT` / `BFF_PORT` / `WEB_BFF_URL`（构建期）。
- 运营端是独立应用，通常部署在内网；不要把 BFF 管理接口暴露到公网。
- 详细说明：`docs/deploy/06-deployment.md`。

---

## 目录结构

```
apps/
  agent-runtime/   Agent 运行时：Agent Loop、工具网关、文档/代码沙箱、嵌入
  bff/             NestJS(Fastify)：认证、会话、任务、附件成果、知识库、连接器、计费、管理端
  web/             Next.js 客户工作台（3000）
  admin/           Next.js 运营平台（3001，独立部署）
packages/
  shared/          协议类型与校验（DTO、SSE 编解码）
  web-core/        两端共用的组件与样式（图表、文件预览、技能编辑器、专家助手表单等）
docs/
  db/              数据库基线 schema.sql（含中文注释）
  design/          设计文档
  develop/         开发指南与数据模型
  deploy/          部署运维
```

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/develop/04-dev-guide.md` | 开发指南：目录、数据模型、关键链路 |
| `docs/db/schema.sql` | 数据库基线（含中文注释） |
| `docs/deploy/06-deployment.md` | 容器化部署与运营端 |
| `docs/superpowers/specs/` | 设计规格 |
| `AGENTS.md` | 仓库强制约定（注释、隔离、提交规范） |

---

## 许可与商业授权

本项目采用 **AI Office Agent 源码可见许可 v1.0**：

| 使用场景 | 是否免费 |
| --- | --- |
| 个人学习、研究、技术验证 | ✅ 免费 |
| 学校教学、开源社区、非营利内部非营收 | ✅ 免费 |
| 企业内部生产使用（办公/客服/研发/知识库） | ❌ 需商业授权 |
| 对外提供 SaaS / API / 托管服务 | ❌ 需商业授权 |
| 私有化交付、收费实施/定制/培训 | ❌ 需商业授权 |
| 嵌入硬件、镜像或商业发行版分发 | ❌ 需商业授权 |

- 完整条款：[LICENSE](./LICENSE)
- 商业授权范围、申请方式与常见问题：[LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md)

> 这不是 OSI 认可的开源许可，而是「源码可见」许可：允许阅读、学习、修改，但**商业
> 使用必须事先取得书面授权**。未授权即用于生产或交付客户，视为违反许可。

## 安全

- 生产部署务必更换 `JWT_SECRET`、`CONNECTOR_ENC_KEY`、`MODEL_ENC_KEY`、`INTERNAL_TOKEN`；
- `agent-runtime` 与 BFF 管理接口不要直接暴露公网；
- 发现安全问题请不要公开提交 Issue，先私下联系维护者。
