-- 数据库表与字段的中文注释。
-- Prisma 不会把注释同步到数据库，本文件由 scripts/apply-comments.mjs 执行；
-- 新增表/字段时请同步在此补充注释。

COMMENT ON TABLE "Tenant" IS '租户表：个人或组织空间，业务数据按租户隔离';
COMMENT ON COLUMN "Tenant"."id" IS '租户 ID';
COMMENT ON COLUMN "Tenant"."type" IS '租户类型：personal（个人）/ organization（组织）';
COMMENT ON COLUMN "Tenant"."name" IS '租户名称';
COMMENT ON COLUMN "Tenant"."plan" IS '套餐类型，默认 free';
COMMENT ON COLUMN "Tenant"."createdAt" IS '创建时间';

COMMENT ON TABLE "User" IS '用户表：登录账号及其所属租户';
COMMENT ON COLUMN "User"."id" IS '用户 ID';
COMMENT ON COLUMN "User"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "User"."email" IS '登录邮箱，统一小写存储';
COMMENT ON COLUMN "User"."passwordHash" IS 'Argon2 密码哈希';
COMMENT ON COLUMN "User"."status" IS '账号状态：active（正常）/ disabled（停用）';
COMMENT ON COLUMN "User"."role" IS '角色：admin（管理员）/ member（成员）';
COMMENT ON COLUMN "User"."createdAt" IS '创建时间';

COMMENT ON TABLE "Session" IS '会话表：一次多轮对话的容器';
COMMENT ON COLUMN "Session"."id" IS '会话 ID';
COMMENT ON COLUMN "Session"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "Session"."userId" IS '所属用户 ID';
COMMENT ON COLUMN "Session"."title" IS '会话标题';
COMMENT ON COLUMN "Session"."status" IS '会话状态：active（进行中）/ archived（已归档）';
COMMENT ON COLUMN "Session"."createdAt" IS '创建时间';

COMMENT ON TABLE "Message" IS '消息表：会话中的用户与助手消息';
COMMENT ON COLUMN "Message"."id" IS '消息 ID';
COMMENT ON COLUMN "Message"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "Message"."role" IS '消息角色：user / assistant / tool';
COMMENT ON COLUMN "Message"."content" IS '消息内容';
COMMENT ON COLUMN "Message"."seq" IS '会话内序号，从 1 递增';
COMMENT ON COLUMN "Message"."tokens" IS '该消息消耗的 token 数';
COMMENT ON COLUMN "Message"."createdAt" IS '创建时间';

COMMENT ON TABLE "Task" IS '任务表：用户提交给智能体的一次目标';
COMMENT ON COLUMN "Task"."id" IS '任务 ID';
COMMENT ON COLUMN "Task"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "Task"."goal" IS '用户任务目标';
COMMENT ON COLUMN "Task"."status" IS '任务状态：queued / running / succeeded / failed';
COMMENT ON COLUMN "Task"."createdAt" IS '创建时间';

COMMENT ON TABLE "Run" IS '执行表：任务的一次具体执行';
COMMENT ON COLUMN "Run"."id" IS '执行 ID';
COMMENT ON COLUMN "Run"."taskId" IS '所属任务 ID';
COMMENT ON COLUMN "Run"."status" IS '执行状态：running / succeeded / failed';
COMMENT ON COLUMN "Run"."startedAt" IS '开始时间';
COMMENT ON COLUMN "Run"."endedAt" IS '结束时间';

COMMENT ON TABLE "Step" IS '步骤表：执行过程中的思考、工具调用与产物事件';
COMMENT ON COLUMN "Step"."id" IS '步骤 ID';
COMMENT ON COLUMN "Step"."runId" IS '所属执行 ID';
COMMENT ON COLUMN "Step"."seq" IS '执行内步骤序号，从 1 递增';
COMMENT ON COLUMN "Step"."type" IS '步骤类型：think / tool_call / tool_result / artifact / confirm_request / notice';
COMMENT ON COLUMN "Step"."payload" IS '步骤结构化数据（JSON）';
COMMENT ON COLUMN "Step"."ts" IS '记录时间';

COMMENT ON TABLE "Artifact" IS '产物表：智能体生成的文档文件';
COMMENT ON COLUMN "Artifact"."id" IS '产物 ID';
COMMENT ON COLUMN "Artifact"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "Artifact"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "Artifact"."runId" IS '产出该文档的执行 ID';
COMMENT ON COLUMN "Artifact"."kind" IS '产物格式：docx / xlsx / pptx';
COMMENT ON COLUMN "Artifact"."filename" IS '文件名';
COMMENT ON COLUMN "Artifact"."storageKey" IS '对象存储键';
COMMENT ON COLUMN "Artifact"."size" IS '文件大小（字节）';
COMMENT ON COLUMN "Artifact"."version" IS '版本号';
COMMENT ON COLUMN "Artifact"."createdAt" IS '创建时间';

COMMENT ON TABLE "KbDoc" IS '知识库文档表：上传的原始文档及其摄取状态';
COMMENT ON COLUMN "KbDoc"."id" IS '文档 ID';
COMMENT ON COLUMN "KbDoc"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "KbDoc"."userId" IS '上传用户 ID';
COMMENT ON COLUMN "KbDoc"."filename" IS '原始文件名';
COMMENT ON COLUMN "KbDoc"."mime" IS 'MIME 类型';
COMMENT ON COLUMN "KbDoc"."size" IS '文件大小（字节）';
COMMENT ON COLUMN "KbDoc"."storageKey" IS '对象存储键';
COMMENT ON COLUMN "KbDoc"."status" IS '摄取状态：pending（处理中）/ ready（就绪）/ failed（失败）';
COMMENT ON COLUMN "KbDoc"."chunkCount" IS '切片数量';
COMMENT ON COLUMN "KbDoc"."error" IS '摄取失败原因';
COMMENT ON COLUMN "KbDoc"."createdAt" IS '创建时间';

COMMENT ON TABLE "KbChunk" IS '知识库切片表：文档切分后的文本块及其向量';
COMMENT ON COLUMN "KbChunk"."id" IS '切片 ID';
COMMENT ON COLUMN "KbChunk"."docId" IS '所属知识库文档 ID';
COMMENT ON COLUMN "KbChunk"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "KbChunk"."userId" IS '上传用户 ID';
COMMENT ON COLUMN "KbChunk"."seq" IS '文档内切片序号';
COMMENT ON COLUMN "KbChunk"."text" IS '切片文本内容';
COMMENT ON COLUMN "KbChunk"."vector" IS '文本向量（pgvector，1024 维）';
COMMENT ON COLUMN "KbChunk"."createdAt" IS '创建时间';

COMMENT ON TABLE "Connector" IS '连接器表：接入的外部 MCP Server 配置';
COMMENT ON COLUMN "Connector"."id" IS '连接器 ID';
COMMENT ON COLUMN "Connector"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "Connector"."name" IS '连接器名称，租户内唯一';
COMMENT ON COLUMN "Connector"."command" IS '启动命令';
COMMENT ON COLUMN "Connector"."args" IS '启动参数（JSON 数组）';
COMMENT ON COLUMN "Connector"."envEncrypted" IS '加密后的环境变量（AES-256-GCM，base64 存储）';
COMMENT ON COLUMN "Connector"."enabled" IS '是否启用';
COMMENT ON COLUMN "Connector"."toolCount" IS '上次校验得到的工具数量';
COMMENT ON COLUMN "Connector"."lastValidatedAt" IS '上次校验时间';
COMMENT ON COLUMN "Connector"."createdBy" IS '创建者用户 ID';
COMMENT ON COLUMN "Connector"."createdAt" IS '创建时间';
COMMENT ON COLUMN "Connector"."updatedAt" IS '更新时间';

COMMENT ON TABLE "Plan" IS '套餐表：订阅档位与每月积分额度';
COMMENT ON COLUMN "Plan"."id" IS '套餐 ID：free / standard / premium / ultimate';
COMMENT ON COLUMN "Plan"."name" IS '套餐展示名';
COMMENT ON COLUMN "Plan"."priceCents" IS '展示价格（分），不参与扣费';
COMMENT ON COLUMN "Plan"."monthlyBaseCredits" IS '每周期发放的基础积分';
COMMENT ON COLUMN "Plan"."monthlyBonusCredits" IS '每周期发放的赠送积分';
COMMENT ON COLUMN "Plan"."maxCreditsPerRun" IS '单次运行最大预占/消耗积分';
COMMENT ON COLUMN "Plan"."rpm" IS '每分钟最大运行发起数';
COMMENT ON COLUMN "Plan"."allowedModels" IS '允许调用的模型列表（按优先级）';
COMMENT ON COLUMN "Plan"."active" IS '是否可订阅';
COMMENT ON COLUMN "Plan"."createdAt" IS '创建时间';

COMMENT ON TABLE "Subscription" IS '订阅表：租户当前套餐与计费周期';
COMMENT ON COLUMN "Subscription"."id" IS '订阅 ID';
COMMENT ON COLUMN "Subscription"."tenantId" IS '所属租户 ID，一个租户一条';
COMMENT ON COLUMN "Subscription"."planId" IS '当前套餐 ID';
COMMENT ON COLUMN "Subscription"."status" IS '状态：active / expired / canceled';
COMMENT ON COLUMN "Subscription"."periodStart" IS '当前周期开始（UTC）';
COMMENT ON COLUMN "Subscription"."periodEnd" IS '当前周期结束（UTC），积分到期时间';
COMMENT ON COLUMN "Subscription"."createdAt" IS '创建时间';
COMMENT ON COLUMN "Subscription"."updatedAt" IS '更新时间';

COMMENT ON TABLE "CreditLot" IS '积分批次表：每批积分的来源、余额与到期时间';
COMMENT ON COLUMN "CreditLot"."id" IS '批次 ID';
COMMENT ON COLUMN "CreditLot"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "CreditLot"."source" IS '来源：base / bonus / pack / adjust';
COMMENT ON COLUMN "CreditLot"."granted" IS '发放数量';
COMMENT ON COLUMN "CreditLot"."remaining" IS '剩余可用数量';
COMMENT ON COLUMN "CreditLot"."expiresAt" IS '到期时间；NULL 表示不过期';
COMMENT ON COLUMN "CreditLot"."note" IS '备注（周期标记等）';
COMMENT ON COLUMN "CreditLot"."createdAt" IS '创建时间';

COMMENT ON TABLE "CreditTx" IS '积分流水表：只追加不修改，保留完整审计链';
COMMENT ON COLUMN "CreditTx"."id" IS '流水 ID';
COMMENT ON COLUMN "CreditTx"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "CreditTx"."type" IS '类型：grant / consume / expire / adjust / refund';
COMMENT ON COLUMN "CreditTx"."amount" IS '有符号数量：发放为正，消耗/过期为负';
COMMENT ON COLUMN "CreditTx"."source" IS '来源标记（base/bonus/pack/adjust/usage）';
COMMENT ON COLUMN "CreditTx"."runId" IS '关联运行 ID（结算幂等键，唯一）';
COMMENT ON COLUMN "CreditTx"."note" IS '备注';
COMMENT ON COLUMN "CreditTx"."createdAt" IS '创建时间';

COMMENT ON TABLE "TenantCredit" IS '租户积分汇总表：余额与已预占额度';
COMMENT ON COLUMN "TenantCredit"."tenantId" IS '租户 ID';
COMMENT ON COLUMN "TenantCredit"."balance" IS '未过期未消耗的积分总额（含已预占）';
COMMENT ON COLUMN "TenantCredit"."reserved" IS '进行中运行预占的积分';
COMMENT ON COLUMN "TenantCredit"."updatedAt" IS '更新时间';

COMMENT ON TABLE "CreditHold" IS '积分预占表：运行前锁定额度，结算或失败时释放';
COMMENT ON COLUMN "CreditHold"."runId" IS '运行 ID（主键，天然幂等）';
COMMENT ON COLUMN "CreditHold"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "CreditHold"."amount" IS '预占积分';
COMMENT ON COLUMN "CreditHold"."createdAt" IS '创建时间';
COMMENT ON COLUMN "CreditHold"."expiresAt" IS '兜底清理时间（24 小时）';

COMMENT ON TABLE "UsageRecord" IS '用量记录表：一次运行的模型 token 与折算积分';
COMMENT ON COLUMN "UsageRecord"."id" IS '记录 ID';
COMMENT ON COLUMN "UsageRecord"."runId" IS '运行 ID（唯一，结算幂等键）';
COMMENT ON COLUMN "UsageRecord"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "UsageRecord"."userId" IS '发起用户 ID';
COMMENT ON COLUMN "UsageRecord"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "UsageRecord"."models" IS '按模型的用量 JSON：[{model,input,output}]';
COMMENT ON COLUMN "UsageRecord"."inputTokens" IS '输入 token 合计';
COMMENT ON COLUMN "UsageRecord"."outputTokens" IS '输出 token 合计';
COMMENT ON COLUMN "UsageRecord"."credits" IS '实际结算积分';
COMMENT ON COLUMN "UsageRecord"."status" IS '状态：pending / settled / void';
COMMENT ON COLUMN "UsageRecord"."createdAt" IS '创建时间';
COMMENT ON COLUMN "UsageRecord"."settledAt" IS '结算时间';

COMMENT ON TABLE "ModelPrice" IS '模型价格表：每千 token 的毫积分费率';
COMMENT ON COLUMN "ModelPrice"."model" IS '模型名（与 runtime 上报一致）';
COMMENT ON COLUMN "ModelPrice"."inputMilliCreditsPer1k" IS '输入每千 token 毫积分费率';
COMMENT ON COLUMN "ModelPrice"."outputMilliCreditsPer1k" IS '输出每千 token 毫积分费率';
COMMENT ON COLUMN "ModelPrice"."updatedAt" IS '更新时间';
