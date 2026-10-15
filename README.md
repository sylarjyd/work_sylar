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
pnpm --filter @ai-office/bff db:up      # 起 Postgres
pnpm --filter @ai-office/bff db:push    # 同步表结构
```

> 网络化部署提醒：agent-runtime 的 `/runs` 无内置鉴权，默认仅绑 `127.0.0.1`。
> 若要对外暴露，必须设 `AGENT_RUNTIME_HOST=0.0.0.0` 并同时配 `AGENT_RUNTIME_TOKEN`
> （BFF 会自动携带同一 token 发起请求）。

## M1 已具备

- 账号：邮箱+密码注册登录，JWT 鉴权
- 会话：多会话、消息历史持久化（Postgres + Prisma）
- Agent：真模型驱动的 Agent Loop（plan→act→observe），内置 `web.search` / `web.fetch`

## 包结构

- `packages/shared` —— 协议类型与 SSE 编解码
- `apps/agent-runtime` —— Agent 运行时（真模型 Agent Loop + web.search / web.fetch）
- `apps/bff` —— NestJS(Fastify) 应用服务
- `apps/web` —— Next.js 网页端
