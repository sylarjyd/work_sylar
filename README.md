# AI 办公智能体（对标 WorkBuddy）

设计文档：`docs/superpowers/specs/2026-10-15-ai-office-agent-design.md`
计划：`docs/superpowers/plans/`

## 开发

```bash
pnpm install
pnpm dev        # 并行启动 agent-runtime(4001) / bff(4000) / web(3000) / admin(3001)
pnpm test       # 全量测试
pnpm build      # 全量构建
```

## 本地配置

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY（缺省时 Agent 走确定性 Mock，链路仍可验证）
pnpm --filter @ai-office/bff db:up      # 起 Postgres / MinIO / Redis（docker compose）
pnpm --filter @ai-office/bff db:push    # 同步表结构
pnpm assets:viewer                      # 文件预览资源（Worker/WASM，约 190MB ×2，已 gitignore）
```

> 本地数据库镜像已改为 **pgvector**（`pgvector/pgvector:pg16`），因此 `CREATE EXTENSION vector` 可用，知识库向量检索开箱即用。

### 对象存储（MinIO / S3）

文档产出（docx/xlsx/pptx）由 agent-runtime 写入 S3 兼容对象存储，bff 代理下载。本地用 MinIO：`db:up` 会一并起 `minio` 容器（S3 端口 9000、控制台 9001，默认账号 `minioadmin/minioadmin`）。连接参数走 `.env` 的 `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET`（见 `.env.example`）。

`artifacts` 桶由 agent-runtime 启动时幂等创建，无需手工建桶；若启动日志出现 `ensureBucket 失败` 告警，说明对象存储未就绪，文档工具会在运行期报错。改完 `.env` 需重启 bff 与 runtime 才会生效（两者仅在启动时加载一次根 `.env`）。

> 网络化部署提醒：agent-runtime 默认仅绑 `127.0.0.1`；未配 `AGENT_RUNTIME_TOKEN` 时
> 只放行回环来源（fail-closed）。若要对外暴露，必须设 `AGENT_RUNTIME_HOST=0.0.0.0`
> 并同时配 `AGENT_RUNTIME_TOKEN`（BFF 会自动携带同一 token 发起请求）。

## M1 已具备

- 账号：邮箱+密码注册登录，JWT 鉴权
- 会话：多会话、消息历史持久化（Postgres + Prisma）
- Agent：真模型驱动的 Agent Loop（plan→act→observe），内置 `web.search` / `web.fetch`

## M2 已具备

- 工具系统：在 `web.search` / `web.fetch` 之外新增文档生成 `doc.docx` / `doc.xlsx` / `doc.pptx`
- 成果区：产出物元数据落库（Postgres），文件存对象存储（MinIO/S3），工作台按会话列表并可下载
- 下载鉴权：仅本租户本人可取，越权与未登录分别返回 404 / 401

## M3 已具备

- 工具权限：工具契约引入 `safe` / `confirm` / `blocked` 三级，`Tool.permission` 必填
- 确认卡片：`confirm` 级工具（`code.exec`）在工作台下发内联卡片，用户允许/拒绝后 loop 继续
- 代码沙箱：`code.exec` 在「子进程 + Node `--permission` + 受限 harness」中执行，无文件/网络/子进程，含超时与输出上限

## M4a 已具备

- 知识库 RAG：上传文档→检索问答→来源引用（pgvector 向量检索；runtime 解析+嵌入，bff 独占库）

## M4b 已具备

- 连接器 / MCP：接入外部 MCP Server（stdio），自动发现其工具并纳入 Agent 工具箱；`/connectors` 页由管理员新增/启停/删除（凭证加密入库），工具调用沿用 M3 确认卡片

## M5a 已具备

- 计费与网关：套餐/订阅、月度积分账本（运行前预占、`usage` 结算、断连补偿）；多模型路由与可重试 fallback、RPM 限流（超限 429、余额不足 402）
- 工作台 `/billing`：套餐、余额、流水与按日/模型用量

## M5b 已具备

- 管理端：用户/会员/会话/任务/模型/参数/审计，`/admin/overview` 看板与 `/admin/alerts` 告警中心
- 可观测：pino 结构化日志（敏感字段脱敏）、OTel 全链路 trace、`/metrics` 指标端点
- 任务队列：BullMQ/Redis 队列（未配 Redis 或 `RUN_QUEUE_ENABLED=0` 时退化为进程内联执行），排队位次与租户/实例并发控制；取消（排队移除 / 执行中按已完成轮次结算）、手动重试、`step` 断点续跑、SSE 断线续流

## 数据图表

- Agent 工具 `chart.render`：模型产出图表规格（折线/面积/柱状/堆叠/饼图/散点），工作台用 ECharts 内联渲染，支持 tooltip、图例与大数据量缩放；图表随 `step` 落库，刷新与续流都能回放。
- 图表不只是实时流：运行结束后从 `chart` step 恢复成对话里的图表区（`GET /api/sessions/:id/charts`），刷新、切会话、回看都能看到；成果栏也新增「图表」分组，点开可放大查看。
- `/billing` 用量页：积分消耗与 token 用量图表；运营端概览的折线与堆叠柱图也已换成 ECharts。

## 附件与成果在线预览

- 集成 **Flyfish File Viewer**（`@file-viewer/react-full`）：工作台成果栏与聊天附件、运营端会话消息里的附件都能在弹窗内直接预览 docx / xlsx / pptx / pdf / 图片 / 音视频等格式；预览失败或格式不支持时保留「下载」兜底。
- 预览通过 **Blob** 中转：BFF 的文件接口要求 `Authorization`，查看器只接收内存文件，不会把带鉴权的直链暴露给 iframe。
- 运行时 Worker/WASM 资源由 `pnpm assets:viewer` 生成到 `apps/{web,admin}/public/file-viewer`（约 190MB/端，已 gitignore）；Docker 构建阶段会自动生成，无需手工拷贝。运营端附件读取走 `GET /api/admin/attachments/:id/content`（仅管理员，写入审计）。
- 图表组件与配色在 `@ai-office/web-core/chart`，两端共用一套视觉；模型只能给数据与类型，配置由前端生成。

## 运营端模型接入

- 「新增厂商」内置常用厂商预设（DeepSeek / OpenAI / 阿里云百炼 / Kimi / 智谱 / 硅基流动 / 火山方舟 / 混元 / 千帆 / OpenRouter / Groq / Ollama / vLLM），选中后自动填好名称与 Base URL，也可手动填写自定义厂商。
- 填好 Base URL 与 API Key 后可点「获取模型列表」：由 BFF 代调厂商 OpenAI 兼容的 `/models`（`POST /api/admin/model-providers/models`，兼容 `data[].id` 与 Ollama 的 `models[].name`），勾选后随「保存」一起创建模型配置；已有模型默认不勾选，价格默认 0，可在列表中逐项调整。
- API Key 只在服务端使用：新建时随请求体一次性传入，编辑已保存厂商时由服务端解密复用，浏览器不直连厂商。

## 一键容器部署

需要已安装 Docker（含 Compose）。Windows 双击/命令行执行 `deploy.cmd`，Linux/macOS 执行 `./deploy.sh`：

```bash
./deploy.sh              # 构建镜像并启动客户端栈（不含运营端）
./deploy.sh --with-admin # 同机额外启动运营端（内网访问）
./deploy.sh --admin-only # 只部署运营端（独立内网主机）
./deploy.sh --no-build   # 复用已有镜像
./deploy.sh --logs       # 启动后跟随日志
./deploy.sh --down       # 停止容器（保留数据卷）
./deploy.sh --down --purge   # 停止并清空数据卷
```

首次运行会基于 `.env.docker.example` 生成 `.env.docker`：随机生成数据库/对象存储/JWT/加密/token/webhook 密钥，并尽量复用根 `.env` 里的模型与嵌入配置。`.env.docker` 含明文密钥，已被 git 忽略，请勿提交。

整套服务：`web`(3000)、`bff`(4000)、`agent-runtime`(4001，仅容器内网)、Postgres/MinIO/Redis（不映射到宿主机），以及一次性的 `db-init`（建 vector 扩展、同步表结构、写入计费种子数据）。端口与对外 BFF 地址在 `.env.docker` 中用 `WEB_PORT` / `BFF_PORT` / `WEB_BFF_URL` 调整；`WEB_BFF_URL` 是 Web 的**构建期**变量，修改后需重新构建。

**运营端是独立应用**（`apps/admin`，默认 3001），通常部署在内网，不随客户端栈默认启动。`--with-admin` 默认只绑定 `127.0.0.1`；内网访问需设置 `ADMIN_WEB_BIND`，并配好防火墙/反向代理，不要把 BFF 管理接口暴露到公网。运营端使用自己的登录页，只接受管理员账号；`ADMIN_BFF_URL` 是其**构建期** BFF 地址。管理员提权（在客户端栈中执行）：

```bash
./deploy.sh --no-build   # 确保已启动
docker compose --env-file .env.docker exec bff node scripts/promote-admin.mjs <邮箱>
```

详细说明见 `docs/deploy/06-deployment.md` §11。

## 包结构

- `packages/shared` —— 协议类型与 SSE 编解码
- `packages/web-core` —— 客户端与运营端共用的认证/追踪/错误文案与全局样式
- `apps/agent-runtime` —— Agent 运行时（真模型 Agent Loop + 检索/抓取 + 文档生成工具、对象存储写入）
- `apps/bff` —— NestJS(Fastify) 应用服务
- `apps/web` —— Next.js 客户工作台（3000）
- `apps/admin` —— Next.js 运营平台（3001，独立部署，仅管理员）
