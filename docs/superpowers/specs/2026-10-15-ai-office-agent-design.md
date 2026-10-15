# AI 办公智能体（对标腾讯 WorkBuddy）· 设计文档

- 日期：2026-10-15
- 状态：已通过分段评审，待用户审阅书面稿
- 关联：WorkBuddy（腾讯 AI 原生桌面智能体，"数字同事"）

## 1. 背景与目标

### 1.1 背景
WorkBuddy 是腾讯推出的 AI 原生桌面智能体，核心理念是让 AI 从"会聊天"进化到"会干活"：用户下达目标，Agent 自行拆解步骤、调用工具执行，直接交付 Word/Excel/PPT 等成果。其被验证过的架构为 **"产品外壳 / app-server / agent-runtime" 三层解耦**，通过稳定协议通信。

本项目目标是复刻其能力，最终交付一个**完整商业产品**，包含服务端、客户端（桌面）、网页端。

### 1.2 现实约束与策略
- 团队：1–2 人、业余节奏。
- 因此采用**逐步演进的商业产品**路线：每个阶段都交付一个可用版本，功能由窄到宽，顺序优先于覆盖面。
- 三端不可并行，必须排序。

### 1.3 目标与非目标
**目标**
- v1：交付网页端可用的 AI 办公智能体（服务端 + 网页端）。
- 架构预留：多租户、桌面端复用同一 Agent 运行时、私有化/信创。

**非目标（v1 明确不做）**
- 桌面端本地文件操作、在线人机双写协作编辑器。
- 企业微信集成、企业后台、SSO、审计中心、定时/远程派活。

### 1.4 已确认的关键决策
| 议题 | 决策 |
|---|---|
| 项目定位 | 完整商业产品（逐步演进） |
| 团队 | 1–2 人 / 业余 |
| v1 链路 | 服务端 + 网页端 |
| 目标用户 | 先个人后企业，架构预留多租户 |
| 技术栈 | 参考 WorkBuddy（TypeScript 体系） |
| v1 架构 | 方案 B —— 三层解耦（对标 WorkBuddy） |

## 2. 技术栈（对齐 WorkBuddy，适配网页端 v1）

WorkBuddy 实际技术栈（含第三方逆向分析，可信度中等）：Electron + VS Code Fork(Monaco) 桌面壳 + 独立 CLI Agent 运行时(sidecar) + React/Vite 渲染层 + MCP 协议 + Rust/C++ 沙箱与文档引擎，Agent 层基于 OpenAI Agents SDK + MCP，持久化 SQLite/JSONL。

映射到本项目 v1（服务端 + 网页端，TypeScript 全栈）：

| 层 | WorkBuddy | 本项目 v1 选型 |
|---|---|---|
| UI | Electron + React/Monaco | **Next.js (React, App Router)** 网页端 |
| 应用服务 | App-Server (daemon) | **NestJS** BFF：账号/计费/会话/文件 |
| Agent 运行时 | CLI sidecar (OpenAI Agents SDK + MCP) | **独立 Node/TS 服务**：Agent Loop / 工具 / 沙箱 / MCP Host |
| 通信 | ACP JSON-RPC + REST + SSE | **JSON-RPC + REST + SSE 流式** |
| 沙箱 | Rust TSbx | **isolated-vm**（v1），可升级为容器 |
| 存储 | SQLite/JSONL | **Postgres(+pgvector) + Redis + 对象存储** |
| 队列 | — | **BullMQ (Redis)** |
| 模型 | 混元 + DeepSeek | **多模型网关**（混元/DeepSeek/通义/GLM + OpenAI 兼容） |
| 文档生成 | Docs 引擎 (C++ FFI) | Node 库：`docx` / `exceljs` / `pptxgenjs` |

> 以上框架为**可调整的默认选型**：若后续有强约束（如团队更熟 Hono/Python），在实施计划阶段替换，不影响分层架构。

## 3. 总体架构与组件边界

系统按 **4 个可独立部署单元 + 1 层基础设施** 组织：

```
Web 前端 (Next.js/React)
  对话/任务流 · 成果预览(docx/xlsx/pptx/pdf) · 知识库 · 设置与计费
        │ HTTPS / SSE
BFF 应用服务 (NestJS) —— 不跑 Agent，只管"业务"
  认证/账号 · 多租户与组织 · 计费与用量 · 会话管理
  文件/产物存储 · 连接器凭证 · 任务编排入口 · SSE 网关
        │ JSON-RPC + SSE（内部协议，对标 ACP）
Agent 运行时 (Node/TS，独立服务) —— "会干活"的引擎
  Session · Agent Loop(plan→act→observe) · 工具注册表
  MCP Host · 沙箱执行 · 子 Agent 编排 · 记忆
        │ 统一调用
模型网关 (Model Gateway)
  多模型路由 · 限流 · 用量埋点 · fallback

基础设施：Postgres(元数据/多租户) · Redis(队列/会话态/限流)
          · 对象存储(文件/产物) · 向量库(pgvector) · 沙箱池
```

### 3.1 一次"下达目标"的完整数据流
1. 用户在 Web 输入目标 → `POST /tasks` 到 BFF。
2. BFF 校验租户/配额 → 建 session/task → 投递到 Agent 运行时（Redis 队列）。
3. Agent 运行时跑 **Agent Loop**：模型思考 ↔ 调用工具（文件/联网/文档生成/MCP/沙箱）↔ 观察结果。
4. 全程以 **SSE 事件**回流 BFF → Web 端实时渲染"思考/工具调用/产物"。
5. 产物（Word/Excel/PPT）落对象存储，BFF 记录用量用于计费。

### 3.2 关键设计判断
- **BFF 与 Agent 运行时分离**：Agent 长任务、需可重启/可恢复/可隔离，进程边界比组件边界更可靠；也让未来桌面端**复用同一套 Agent 运行时**。
- **模型网关单列**：多模型、私有化换模型、按 token 计费、限流收口到一处。

## 4. 核心领域模型与数据

**统一多租户**：所有业务表带 `tenant_id`；个人用户 = 一个 personal 租户，企业 = org 租户。v1 只跑个人版，但表结构预留。

| 实体 | 说明 | 关键字段 |
|---|---|---|
| `tenant` | 租户/组织 | id, type(personal/org), name, plan, seats |
| `user` | 用户 | id, tenant_id, email/phone, status |
| `membership` | 成员角色（企业用） | tenant_id, user_id, role(owner/admin/member) |
| `session` | 会话（一段上下文） | id, tenant_id, user_id, title, status |
| `message` | 对话消息 | id, session_id, role, content, tokens |
| `task` | 用户下达的目标/任务 | id, session_id, goal, status(queued/running/done/failed), agent_id |
| `run` | 一次 Agent 执行实例 | id, task_id, status, started_at, cost |
| `step` | Agent loop 的单步 | id, run_id, seq, type(think/tool_call/tool_result/artifact), payload |
| `artifact` | 产出物 | id, run_id, kind(docx/xlsx/pptx/pdf), storage_key, version |
| `file` | 用户/工作区文件 | id, tenant_id, storage_key, mime, size |
| `connector` | 连接器与凭证 | id, tenant_id, kind(mcp/notion/github…), config_encrypted |
| `tool` | 工具/技能注册 | id, name, schema, source(builtin/mcp/skill) |
| `kb` / `kb_doc` / `kb_chunk` | RAG 知识库 | 向量存 pgvector，元数据存 PG |
| `usage_record` | 计费用量 | tenant_id, model, tokens_in/out, ts |
| `agent_definition` | 可配置 Agent | id, tenant_id, model, system_prompt, tools[] |

### 4.1 存储分工
- **Postgres(+pgvector)**：全部结构化元数据 + 多租户 + 计费 + 向量。
- **Redis**：任务队列、会话运行态、限流计数、（可选）短期记忆。
- **对象存储**：用户文件、产物、知识库原文。

### 4.2 关键设计判断
- `step` 表把 Agent 每一步（思考/工具调用/结果/产物）落库 —— 既是**实时渲染 SSE 的数据源**，也是**审计与回放**的基础。
- `connector.config_encrypted`：凭证**加密入库**。
- `agent_definition`：让"多 Agent / 按岗位配置"数据驱动，而非硬编码。

## 5. Agent 运行时（引擎核心）

对标 WorkBuddy 的 CLI sidecar。五块：

### 5.1 Agent Loop（可中断 / 可恢复）
```
prompt → 规划(plan) → 模型调用(流式) → 工具调用 → 执行工具 → 观察结果 → 循环
                                          ↘ 产出 artifact ↗
```
每步写 `step` 表 = **checkpoint**，任务可暂停/恢复/回放。轮次有 token 预算上限，超限触发上下文压缩或中止。

### 5.2 工具系统（Tool Registry）
- **声明式注册**：工具 = `name + description + JSON-Schema 参数 + 权限等级`。
- **v1 内置工具集**：`web.search` / `web.fetch`、`file.read/write/list/move`、`doc.docx/xlsx/pptx`、`kb.retrieve`、`code.exec`。MCP 外部工具自动并入。
- **权限三级 `safe / confirm / blocked`**：破坏性操作前端弹**确认卡片**（工具名 + 入参），授权后执行；删除重定向回收站、修改前自动备份。

### 5.3 MCP Host
- 管理 MCP Server 子进程生命周期：**守护 + 心跳 ping + 崩溃退避重拉**。
- stdio / SSE 两种传输，`initialize` 握手后**自动发现工具**并注入注册表。
- **Context Optimizer**：返回报文剪枝、结果摘要，防上下文爆炸。

### 5.4 沙箱执行
- 每个 `run` 独立沙箱（v1：`isolated-vm`），代码执行与文件操作限制在受限工作区。
- 高危操作（磁盘格式化、越权路径）拦截。

### 5.5 多 Agent / 子 Agent
- 主 Agent 可**派生并行子 Agent** 跑独立子任务，结果汇总回主 Agent（对标 CodeBuddy Sub Agent，默认开启）。
- 子 Agent 上下文隔离，避免污染主线。

### 5.6 协议（BFF ↔ 运行时）
- **JSON-RPC 方法**：`session.create` / `prompt` / `interrupt` / `resume`。
- **SSE 事件**：`step.delta · tool.call · tool.result · artifact.created · usage`。

## 6. 网页端 v1 功能范围

| 页面/模块 | v1 做什么 |
|---|---|
| 任务工作台（主界面） | 输入目标 → 实时渲染 `思考/工具调用/结果`（SSE）；中断/恢复；确认卡片交互 |
| 成果区 | 产物列表 + 在线预览（docx/xlsx/pptx/pdf）+ 下载 + 版本 |
| 知识库（RAG） | 上传 → 解析/切分/向量化 → 检索问答；来源引用 |
| 连接器 | 添加/管理 MCP Server 与外部凭证 |
| 账号与计费 | 注册登录、套餐、用量查询 |
| 组织管理 | 仅预留入口/路由，v1 不实现功能 |

**v1 明确不做**：在线人机双写编辑器、企微集成、企业后台/SSO/审计、桌面端本地文件操作、定时/远程派活。

**v1 验收标准**：用户能在网页里下达一个目标（如"调研 X 并生成一份 PPT"），实时看到 Agent 干活，最终下载到成果。

## 7. 非功能需求

- **安全**：连接器凭证加密入库；工具权限三级 + 确认卡片；沙箱隔离；删除→回收站 + 修改前备份；`tenant_id` 强制行级隔离（每表 + 每查询）。
- **可观测**：结构化日志 + 每个 `run/step` 全链路 trace + token/成本指标 + 任务回放。
- **错误处理**：工具失败→重试/降级并记 `step`；模型失败→网关重试 + fallback 模型；长任务超时→可恢复；SSE 断连→重新订阅续传。
- **测试策略**：Agent Loop 单元测试（工具打桩）· BFF↔运行时 **JSON-RPC 契约测试** · 端到端用例（下达目标→产出文件）· 沙箱逃逸安全测试。
- **私有化/信创预留**：模型网关可换国产模型、无强托管依赖、可容器化私有部署（v1 不做，架构不挡）。
- **认证默认**：邮箱/手机号 + OTP，JWT；预留 OAuth（微信/企微）。

## 8. 里程碑分期

| 期 | 目标 | 产出 |
|---|---|---|
| **M0 脚手架** | 三层骨架 + SSE 打通 | 前端能收到运行时的流式事件 |
| **M1 最小闭环** | 账号 + 会话 + 基础 Agent Loop（单模型 + 2 个内置工具） | 能对话并调用联网工具 |
| **M2 会干活** | 工具系统 + 文档生成 + 成果区 | 产出并可下载 docx/xlsx/pptx |
| **M3 安全** | 沙箱 + 确认卡片 + 权限分级 | 破坏性操作需确认 |
| **M4 扩展** | 知识库 RAG + 连接器/MCP | 接外部工具、文档问答 |
| **M5 商业化** | 计费 + 用量 + 可观测 + 上线个人版 | 个人版可对外 |

**阶段二（后续）**：桌面端（Electron + Monaco，复用 Agent 运行时）→ 人机双写。
**阶段三（后续）**：企业层（组织/权限/审计/SSO/私有化/信创）→ 企微集成。

## 9. 未决问题（实施计划阶段前需确认）

1. 后端框架最终选型：NestJS（默认，结构化、利于多租户）vs Hono（更轻）。
2. Web 框架：Next.js（默认）vs Vite SPA。
3. 首个默认模型与模型网关实现方式（自研抽象 vs LiteLLM 类）。
4. 对象存储与部署环境（自建 MinIO vs 云对象存储）。
5. v1 是否引入多 Agent（默认仅单 Agent + 预留接口）。
