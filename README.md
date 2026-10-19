# AI 办公智能体（对标 WorkBuddy）

设计文档：`docs/superpowers/specs/2026-10-15-ai-office-agent-design.md`
计划：`docs/superpowers/plans/`

## 开发

```bash
pnpm install
pnpm dev        # 并行启动 agent-runtime(4001) / bff(4000) / web(3000)
pnpm test       # 全量测试
pnpm build      # 全量构建
```

## 本地配置

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY（缺省时 Agent 走确定性 Mock，链路仍可验证）
pnpm --filter @ai-office/bff db:up      # 起 Postgres 与 MinIO（docker compose）
pnpm --filter @ai-office/bff db:push    # 同步表结构
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

## 包结构

- `packages/shared` —— 协议类型与 SSE 编解码
- `apps/agent-runtime` —— Agent 运行时（真模型 Agent Loop + 检索/抓取 + 文档生成工具、对象存储写入）
- `apps/bff` —— NestJS(Fastify) 应用服务
- `apps/web` —— Next.js 网页端
