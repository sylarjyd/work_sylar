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

## 包结构

- `packages/shared` —— 协议类型与 SSE 编解码
- `apps/agent-runtime` —— Agent 运行时（M0 为模拟循环）
- `apps/bff` —— NestJS(Fastify) 应用服务
- `apps/web` —— Next.js 网页端
