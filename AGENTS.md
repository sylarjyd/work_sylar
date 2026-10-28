# 仓库级约定（所有 AI 会话必读）

## 数据库中文注释（强制，长期有效）

- **新增表**：必须在 `apps/bff/prisma/comments.sql` 写 `COMMENT ON TABLE`。
- **新增字段**（含改名/加列）：必须写 `COMMENT ON COLUMN`，不能只注释表。
- 注释一律中文，写业务语义；枚举/状态列要列全取值（如 `queued / running / done / failed / canceled`）。
- 同步与校验：
  - `pnpm --filter @ai-office/bff db:push` —— 推送表结构后自动应用注释并校验；
  - `pnpm --filter @ai-office/bff db:comments` —— 只应用注释；
  - `pnpm --filter @ai-office/bff db:comments:check` —— 只校验，缺失时列出表/字段并非零退出。
- 缺注释的变更不允许提交。Prisma 的 `///` 注释不会进数据库，`comments.sql` 是唯一来源。

## 其他必须遵守的约定

- 所有数据库查询带 `tenantId` 并逐查询校验归属；越权返回 404，不泄露存在性。
- 提交信息用中文，格式 `type(scope): 中文摘要`，正文写「为什么改」。
- 跨层类型只在 `@ai-office/shared` 定义；改完先 `pnpm --filter @ai-office/shared build`。
- 不擅自提交、不 `amend`；`git add` 只用显式路径。
- 完整规范见 `docs/develop/04-dev-guide.md`。
