-- =============================================================================
-- AI 办公智能体 · 数据库 Schema（PostgreSQL 16）
-- -----------------------------------------------------------------------------
-- 本文件是 apps/bff/prisma/schema.prisma 的等价 DDL（30 张表），用于：
--   1) 首次建库的基线（无 Prisma 迁移历史时）；
--   2) 审阅数据模型 / 供 DBA 参考。
--
-- 权威来源：Prisma schema（当前无迁移历史，开发用 db push）。
--   常规变更请改 Prisma schema，再同步本文件与 prisma/comments.sql，避免漂移。
--
-- 重新生成：
--   cd apps/bff
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
--   再补回文末的 pgvector 扩展、HNSW 索引与中文注释段。
--
-- 应用方式：
--   psql "$DATABASE_URL" -f docs/db/schema.sql
--
-- 说明：
--   - 标识符大小写敏感，Prisma 使用模型/字段原样名，故全部加双引号。
--   - `gen_random_uuid()` 在 PostgreSQL 13+ 为内置函数，无需 pgcrypto 扩展。
--   - 时间戳对应 Prisma 的 TIMESTAMP(3)（毫秒精度，无时区）。
--   - 外键默认 ON DELETE RESTRICT ON UPDATE CASCADE（Prisma 默认行为）。
--   - 表与字段的中文注释附在文末，内容与 apps/bff/prisma/comments.sql 保持一致；
--     新增表/字段时必须两处同步，db:comments:check 会校验。
-- =============================================================================

-- M4a 知识库：pgvector 扩展（镜像 pgvector/pgvector:pg16 自带）。
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'personal',
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '新会话',
    "titleSource" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'active',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "assistantId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assistant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "permissionMode" TEXT NOT NULL DEFAULT 'standard',
    "model" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kbIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kbDocIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "tokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "input" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "traceId" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunCheckpoint" (
    "runId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "deltas" JSONB NOT NULL,
    "usage" JSONB NOT NULL,
    "artifactIds" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunCheckpoint_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbDoc" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbChunk" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "vector" vector(1024) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMemory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "content" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "vector" vector(1024) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "envEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "toolCount" INTEGER NOT NULL DEFAULT 0,
    "lastValidatedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "monthlyBaseCredits" INTEGER NOT NULL,
    "monthlyBonusCredits" INTEGER NOT NULL,
    "maxCreditsPerRun" INTEGER NOT NULL,
    "rpm" INTEGER NOT NULL,
    "allowedModels" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "granted" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTx" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT,
    "runId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantCredit" (
    "tenantId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCredit_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "CreditHold" (
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditHold_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "credits" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "apiKeyHint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPrice" (
    "model" TEXT NOT NULL,
    "providerId" TEXT,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "modalities" TEXT[] DEFAULT ARRAY['text']::TEXT[],
    "capabilities" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "inputMilliCreditsPer1k" INTEGER NOT NULL,
    "outputMilliCreditsPer1k" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPrice_pkey" PRIMARY KEY ("model")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "summary" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricBucket" (
    "id" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "metric" TEXT NOT NULL,
    "dimensionType" TEXT NOT NULL DEFAULT 'global',
    "dimensionId" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "cooldownMinutes" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "message" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "deliveryStatus" TEXT,
    "deliveryError" TEXT,
    "openKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ownerUserId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRunId" TEXT,
    "sharedAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "Session_tenantId_userId_status_pinned_createdAt_idx" ON "Session"("tenantId", "userId", "status", "pinned", "createdAt");

-- CreateIndex
CREATE INDEX "Session_assistantId_idx" ON "Session"("assistantId");

-- CreateIndex
CREATE INDEX "Assistant_tenantId_userId_idx" ON "Assistant"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Assistant_tenantId_userId_name_key" ON "Assistant"("tenantId", "userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_seq_key" ON "Message"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "Attachment_tenantId_userId_idx" ON "Attachment"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Attachment_sessionId_idx" ON "Attachment"("sessionId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE INDEX "Task_sessionId_idx" ON "Task"("sessionId");

-- CreateIndex
CREATE INDEX "Task_status_queuedAt_idx" ON "Task"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "Run_taskId_idx" ON "Run"("taskId");

-- CreateIndex
CREATE INDEX "Run_status_startedAt_idx" ON "Run"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Run_traceId_idx" ON "Run"("traceId");

-- CreateIndex
CREATE INDEX "Run_startedAt_idx" ON "Run"("startedAt");

-- CreateIndex
CREATE INDEX "Step_ts_idx" ON "Step"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "Step_runId_seq_key" ON "Step"("runId", "seq");

-- CreateIndex
CREATE INDEX "Artifact_sessionId_idx" ON "Artifact"("sessionId");

-- CreateIndex
CREATE INDEX "Artifact_tenantId_idx" ON "Artifact"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_tenantId_userId_idx" ON "KnowledgeBase"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_tenantId_idx" ON "KnowledgeBase"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBase_tenantId_userId_name_key" ON "KnowledgeBase"("tenantId", "userId", "name");

-- CreateIndex
CREATE INDEX "KbDoc_tenantId_userId_idx" ON "KbDoc"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "KbDoc_knowledgeBaseId_idx" ON "KbDoc"("knowledgeBaseId");

-- CreateIndex
CREATE INDEX "KbDoc_tenantId_userId_knowledgeBaseId_idx" ON "KbDoc"("tenantId", "userId", "knowledgeBaseId");

-- CreateIndex
CREATE INDEX "KbChunk_docId_idx" ON "KbChunk"("docId");

-- CreateIndex
CREATE INDEX "KbChunk_tenantId_userId_idx" ON "KbChunk"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "UserMemory_tenantId_userId_createdAt_idx" ON "UserMemory"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserMemory_tenantId_userId_hash_key" ON "UserMemory"("tenantId", "userId", "hash");

-- CreateIndex
CREATE INDEX "Connector_tenantId_idx" ON "Connector"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_tenantId_name_key" ON "Connector"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_tenantId_key" ON "Subscription"("tenantId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE INDEX "CreditLot_tenantId_expiresAt_idx" ON "CreditLot"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "CreditLot_expiresAt_idx" ON "CreditLot"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTx_runId_key" ON "CreditTx"("runId");

-- CreateIndex
CREATE INDEX "CreditTx_tenantId_createdAt_idx" ON "CreditTx"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditHold_tenantId_idx" ON "CreditHold"("tenantId");

-- CreateIndex
CREATE INDEX "CreditHold_expiresAt_idx" ON "CreditHold"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_runId_key" ON "UsageRecord"("runId");

-- CreateIndex
CREATE INDEX "UsageRecord_tenantId_createdAt_idx" ON "UsageRecord"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_status_createdAt_idx" ON "UsageRecord"("status", "createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_createdAt_idx" ON "UsageRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProvider_name_key" ON "ModelProvider"("name");

-- CreateIndex
CREATE INDEX "ModelPrice_providerId_idx" ON "ModelPrice"("providerId");

-- CreateIndex
CREATE INDEX "ModelPrice_enabled_sortOrder_idx" ON "ModelPrice"("enabled", "sortOrder");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "MetricBucket_metric_bucketStart_idx" ON "MetricBucket"("metric", "bucketStart");

-- CreateIndex
CREATE INDEX "MetricBucket_dimensionType_dimensionId_bucketStart_idx" ON "MetricBucket"("dimensionType", "dimensionId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "MetricBucket_bucketStart_metric_dimensionType_dimensionId_key" ON "MetricBucket"("bucketStart", "metric", "dimensionType", "dimensionId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRule_key_key" ON "AlertRule"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AlertEvent_openKey_key" ON "AlertEvent"("openKey");

-- CreateIndex
CREATE INDEX "AlertEvent_ruleId_startedAt_idx" ON "AlertEvent"("ruleId", "startedAt");

-- CreateIndex
CREATE INDEX "AlertEvent_status_startedAt_idx" ON "AlertEvent"("status", "startedAt");

-- CreateIndex
CREATE INDEX "AlertEvent_startedAt_idx" ON "AlertEvent"("startedAt");

-- CreateIndex
CREATE INDEX "Skill_scope_enabled_updatedAt_idx" ON "Skill"("scope", "enabled", "updatedAt");

-- CreateIndex
CREATE INDEX "Skill_tenantId_ownerUserId_idx" ON "Skill"("tenantId", "ownerUserId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "Assistant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunCheckpoint" ADD CONSTRAINT "RunCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Step" ADD CONSTRAINT "Step_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbDoc" ADD CONSTRAINT "KbDoc_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbChunk" ADD CONSTRAINT "KbChunk_docId_fkey" FOREIGN KEY ("docId") REFERENCES "KbDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCredit" ADD CONSTRAINT "TenantCredit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelPrice" ADD CONSTRAINT "ModelPrice_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- pgvector HNSW 索引（Prisma 不生成 Unsupported 类型的索引，需手工维护）
-- -----------------------------------------------------------------------------
CREATE INDEX "kb_chunk_vec_idx" ON "KbChunk" USING hnsw ("vector" vector_cosine_ops);
CREATE INDEX "user_memory_vec_idx" ON "UserMemory" USING hnsw ("vector" vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- 表与字段中文注释（与 apps/bff/prisma/comments.sql 一致，由 db:comments 应用）
-- -----------------------------------------------------------------------------
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
COMMENT ON COLUMN "Session"."titleSource" IS '标题来源：auto（待自动生成）/ generated（自动生成）/ manual（用户改名）';
COMMENT ON COLUMN "Session"."status" IS '会话状态：active（进行中）/ archived（已归档）/ deleted（用户删除，软删除）';
COMMENT ON COLUMN "Session"."pinned" IS '是否置顶：列表排序优先，不改变创建时间';
COMMENT ON COLUMN "Session"."model" IS '会话选定的模型名；历史会话为空，首次运行后回填';
COMMENT ON COLUMN "Session"."assistantId" IS '会话选定的自定义助手 ID；助手被删除后置空';
COMMENT ON COLUMN "Session"."mode" IS '任务分类：chat（对话）/ task（任务）/ code（编码）';
COMMENT ON COLUMN "Session"."createdAt" IS '创建时间';
COMMENT ON TABLE "Assistant" IS '自定义助手表：系统提示词、技能、权限模式、默认模型与知识库范围';
COMMENT ON COLUMN "Assistant"."id" IS '助手 ID';
COMMENT ON COLUMN "Assistant"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "Assistant"."userId" IS '创建者用户 ID';
COMMENT ON COLUMN "Assistant"."name" IS '助手名称，同一用户下唯一';
COMMENT ON COLUMN "Assistant"."description" IS '助手简介';
COMMENT ON COLUMN "Assistant"."systemPrompt" IS '系统提示词';
COMMENT ON COLUMN "Assistant"."permissionMode" IS '权限模式：standard（标准）/ readonly（只读）/ auto（自动执行）';
COMMENT ON COLUMN "Assistant"."model" IS '默认模型名；为空时使用运营端默认模型';
COMMENT ON COLUMN "Assistant"."skills" IS '启用的技能键列表';
COMMENT ON COLUMN "Assistant"."skillIds" IS '绑定的技能市场技能 ID 列表；运行期拼接对应技能正文';
COMMENT ON COLUMN "Assistant"."kbIds" IS '绑定的知识库 ID 列表';
COMMENT ON COLUMN "Assistant"."kbDocIds" IS '已废弃：旧文档级绑定，迁移到 kbIds 后置空';
COMMENT ON COLUMN "Assistant"."createdAt" IS '创建时间';
COMMENT ON COLUMN "Assistant"."updatedAt" IS '更新时间';
COMMENT ON TABLE "Message" IS '消息表：会话中的用户与助手消息';
COMMENT ON COLUMN "Message"."id" IS '消息 ID';
COMMENT ON COLUMN "Message"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "Message"."role" IS '消息角色：user / assistant / tool';
COMMENT ON COLUMN "Message"."content" IS '消息内容';
COMMENT ON COLUMN "Message"."seq" IS '会话内序号，从 1 递增';
COMMENT ON COLUMN "Message"."tokens" IS '该消息消耗的 token 数';
COMMENT ON COLUMN "Message"."createdAt" IS '创建时间';
COMMENT ON TABLE "Attachment" IS '聊天附件表：用户上传的图片与文件，发送时绑定到消息';
COMMENT ON COLUMN "Attachment"."id" IS '附件 ID';
COMMENT ON COLUMN "Attachment"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "Attachment"."userId" IS '上传用户 ID';
COMMENT ON COLUMN "Attachment"."sessionId" IS '所属会话 ID；发送前为空';
COMMENT ON COLUMN "Attachment"."messageId" IS '绑定的消息 ID；发送前为空';
COMMENT ON COLUMN "Attachment"."kind" IS '附件类型：text / image / audio / video';
COMMENT ON COLUMN "Attachment"."filename" IS '原始文件名';
COMMENT ON COLUMN "Attachment"."mime" IS 'MIME 类型';
COMMENT ON COLUMN "Attachment"."size" IS '文件大小（字节）';
COMMENT ON COLUMN "Attachment"."storageKey" IS '对象存储键';
COMMENT ON COLUMN "Attachment"."createdAt" IS '上传时间';
COMMENT ON TABLE "Task" IS '任务表：用户提交给智能体的一次目标';
COMMENT ON COLUMN "Task"."id" IS '任务 ID';
COMMENT ON COLUMN "Task"."sessionId" IS '所属会话 ID';
COMMENT ON COLUMN "Task"."goal" IS '用户任务目标';
COMMENT ON COLUMN "Task"."status" IS '任务状态：queued（排队）/ running（执行中）/ done（成功）/ failed（失败）/ canceled（已取消）';
COMMENT ON COLUMN "Task"."input" IS '入队时的运行快照：消息历史、助手配置、会话模型与 traceId（JSON）';
COMMENT ON COLUMN "Task"."attempts" IS '已创建的运行次数（含重试）';
COMMENT ON COLUMN "Task"."lastError" IS '最近一次失败原因';
COMMENT ON COLUMN "Task"."queuedAt" IS '入队时间';
COMMENT ON COLUMN "Task"."startedAt" IS '开始执行时间';
COMMENT ON COLUMN "Task"."endedAt" IS '结束时间';
COMMENT ON COLUMN "Task"."createdAt" IS '创建时间';
COMMENT ON TABLE "Run" IS '执行表：任务的一次具体执行';
COMMENT ON COLUMN "Run"."id" IS '执行 ID';
COMMENT ON COLUMN "Run"."taskId" IS '所属任务 ID';
COMMENT ON COLUMN "Run"."attempt" IS '第几次尝试：首次为 1，手动重试逐次递增';
COMMENT ON COLUMN "Run"."status" IS '执行状态：queued（排队）/ running（执行中）/ done（成功）/ failed（失败）/ canceled（已取消）';
COMMENT ON COLUMN "Run"."startedAt" IS '开始时间';
COMMENT ON COLUMN "Run"."endedAt" IS '结束时间';
COMMENT ON COLUMN "Run"."cancelRequestedAt" IS '取消请求时间；为空表示未请求取消';
COMMENT ON COLUMN "Run"."traceId" IS '发起本次运行的前端/BFF traceId，用于串联调用链';
COMMENT ON TABLE "RunCheckpoint" IS '运行断点表：每 run 仅一行，记录最后完整轮次的恢复状态';
COMMENT ON COLUMN "RunCheckpoint"."runId" IS '所属执行 ID（主键，一 run 一行）';
COMMENT ON COLUMN "RunCheckpoint"."round" IS '已完成的轮次数（下一轮从 round+1 开始）';
COMMENT ON COLUMN "RunCheckpoint"."seq" IS '下一事件序号（已落库步骤的最大 seq + 1）';
COMMENT ON COLUMN "RunCheckpoint"."deltas" IS '截至该轮的 assistant/tool 消息累计（JSON）';
COMMENT ON COLUMN "RunCheckpoint"."usage" IS '截至该轮的 token 与积分用量（JSON）';
COMMENT ON COLUMN "RunCheckpoint"."artifactIds" IS '已落库的产物 ID 列表；续跑时清理未列入的记录';
COMMENT ON COLUMN "RunCheckpoint"."updatedAt" IS '更新时间';
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
COMMENT ON TABLE "KnowledgeBase" IS '知识库表：每用户可建多个，文档与助手绑定都落到这一层';
COMMENT ON COLUMN "KnowledgeBase"."id" IS '知识库 ID';
COMMENT ON COLUMN "KnowledgeBase"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "KnowledgeBase"."userId" IS '所属用户 ID';
COMMENT ON COLUMN "KnowledgeBase"."name" IS '知识库名称，同一用户下唯一';
COMMENT ON COLUMN "KnowledgeBase"."description" IS '知识库简介';
COMMENT ON COLUMN "KnowledgeBase"."createdAt" IS '创建时间';
COMMENT ON COLUMN "KnowledgeBase"."updatedAt" IS '更新时间';
COMMENT ON TABLE "KbDoc" IS '知识库文档表：上传的原始文档及其摄取状态';
COMMENT ON COLUMN "KbDoc"."id" IS '文档 ID';
COMMENT ON COLUMN "KbDoc"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "KbDoc"."userId" IS '上传用户 ID';
COMMENT ON COLUMN "KbDoc"."knowledgeBaseId" IS '所属知识库 ID；存量数据可能为空，回填后强制赋值';
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
COMMENT ON TABLE "UserMemory" IS '长期记忆表：跨会话的用户偏好与事实，按租户 + 用户隔离';
COMMENT ON COLUMN "UserMemory"."id" IS '记忆 ID';
COMMENT ON COLUMN "UserMemory"."tenantId" IS '所属租户 ID';
COMMENT ON COLUMN "UserMemory"."userId" IS '所属用户 ID';
COMMENT ON COLUMN "UserMemory"."sessionId" IS '来源会话 ID，仅作溯源，不建外键';
COMMENT ON COLUMN "UserMemory"."content" IS '记忆正文（一句事实或偏好）';
COMMENT ON COLUMN "UserMemory"."hash" IS '归一化内容的 SHA-256，用于同用户去重';
COMMENT ON COLUMN "UserMemory"."vector" IS '记忆向量（pgvector，1024 维）';
COMMENT ON COLUMN "UserMemory"."createdAt" IS '写入时间';
COMMENT ON COLUMN "UserMemory"."lastUsedAt" IS '最近一次被检索注入的时间';
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
COMMENT ON TABLE "ModelProvider" IS '模型厂商表：运营端配置的 OpenAI 兼容接入点与加密密钥';
COMMENT ON COLUMN "ModelProvider"."id" IS '厂商 ID';
COMMENT ON COLUMN "ModelProvider"."name" IS '厂商名称，全局唯一';
COMMENT ON COLUMN "ModelProvider"."baseUrl" IS 'OpenAI 兼容接口地址';
COMMENT ON COLUMN "ModelProvider"."apiKeyEnc" IS '加密后的 API Key（AES-256-GCM），永不回传前端';
COMMENT ON COLUMN "ModelProvider"."apiKeyHint" IS 'API Key 尾号提示，供运营端展示';
COMMENT ON COLUMN "ModelProvider"."createdAt" IS '创建时间';
COMMENT ON COLUMN "ModelProvider"."updatedAt" IS '更新时间';
COMMENT ON TABLE "ModelPrice" IS '模型配置表：模型目录、能力与模态，以及每千 token 的毫积分费率';
COMMENT ON COLUMN "ModelPrice"."model" IS '模型名（与 runtime 上报一致）';
COMMENT ON COLUMN "ModelPrice"."providerId" IS '所属模型厂商 ID；为空表示使用环境变量里的默认接入点';
COMMENT ON COLUMN "ModelPrice"."displayName" IS '展示名称；为空时使用模型名';
COMMENT ON COLUMN "ModelPrice"."enabled" IS '是否启用：启用后才出现在可用模型目录';
COMMENT ON COLUMN "ModelPrice"."modalities" IS '支持的输入/输出模态：text / image / audio / video';
COMMENT ON COLUMN "ModelPrice"."capabilities" IS '模型能力分类：chat / embedding / rerank / tts / asr';
COMMENT ON COLUMN "ModelPrice"."sortOrder" IS '目录排序值，越小越靠前';
COMMENT ON COLUMN "ModelPrice"."inputMilliCreditsPer1k" IS '输入每千 token 毫积分费率';
COMMENT ON COLUMN "ModelPrice"."outputMilliCreditsPer1k" IS '输出每千 token 毫积分费率';
COMMENT ON COLUMN "ModelPrice"."updatedAt" IS '更新时间';
COMMENT ON TABLE "Setting" IS '系统配置表：运营平台可调的运行参数，取值优先级为 DB > 环境变量 > 默认值';
COMMENT ON COLUMN "Setting"."key" IS '配置键（见 SETTING_SPECS，如 maxRounds / confirmTimeoutMs / alertsEnabled）';
COMMENT ON COLUMN "Setting"."value" IS '配置值（JSON 标量：数字 / 布尔 / 字符串）';
COMMENT ON COLUMN "Setting"."updatedBy" IS '最后修改的管理员用户 ID';
COMMENT ON COLUMN "Setting"."updatedAt" IS '更新时间';
COMMENT ON TABLE "AdminAuditLog" IS '管理员操作审计表：记录运营平台关键操作，只追加不修改';
COMMENT ON COLUMN "AdminAuditLog"."id" IS '审计日志 ID';
COMMENT ON COLUMN "AdminAuditLog"."actorId" IS '操作者用户 ID';
COMMENT ON COLUMN "AdminAuditLog"."actorEmail" IS '操作者邮箱快照（用户变更后仍可追溯）';
COMMENT ON COLUMN "AdminAuditLog"."action" IS '操作类型，如 user.update / setting.update / run.view';
COMMENT ON COLUMN "AdminAuditLog"."targetType" IS '操作对象类型，如 user / tenant / session / setting';
COMMENT ON COLUMN "AdminAuditLog"."targetId" IS '操作对象 ID';
COMMENT ON COLUMN "AdminAuditLog"."summary" IS '操作摘要（JSON，密钥类字段已脱敏）';
COMMENT ON COLUMN "AdminAuditLog"."ip" IS '操作来源 IP';
COMMENT ON COLUMN "AdminAuditLog"."createdAt" IS '创建时间';
COMMENT ON TABLE "MetricBucket" IS '小时级指标快照表：运营端可观测统计的预聚合结果';
COMMENT ON COLUMN "MetricBucket"."id" IS '快照 ID';
COMMENT ON COLUMN "MetricBucket"."bucketStart" IS '统计窗口起点（整点 UTC）';
COMMENT ON COLUMN "MetricBucket"."metric" IS '指标名，如 runs_started / runs_failed / input_tokens / tool_calls';
COMMENT ON COLUMN "MetricBucket"."dimensionType" IS '维度类型：global（全局）/ model（模型）/ tenant（租户）/ tool（工具）';
COMMENT ON COLUMN "MetricBucket"."dimensionId" IS '维度值：模型名、租户 ID 或工具名；global 维度为空串';
COMMENT ON COLUMN "MetricBucket"."value" IS '指标值，语义由 metric 决定（计数类为求和，时长类为累计毫秒）';
COMMENT ON COLUMN "MetricBucket"."count" IS '参与统计的样本数';
COMMENT ON COLUMN "MetricBucket"."updatedAt" IS '更新时间';
COMMENT ON TABLE "AlertRule" IS '告警规则表：运营平台配置的指标阈值规则';
COMMENT ON COLUMN "AlertRule"."id" IS '规则 ID';
COMMENT ON COLUMN "AlertRule"."key" IS '规则唯一标识（用于种子数据与幂等更新）';
COMMENT ON COLUMN "AlertRule"."name" IS '规则展示名';
COMMENT ON COLUMN "AlertRule"."metric" IS '监控指标名（对应 MetricBucket.metric）';
COMMENT ON COLUMN "AlertRule"."comparator" IS '比较方式：gt（大于阈值）/ lt（小于阈值）';
COMMENT ON COLUMN "AlertRule"."threshold" IS '阈值';
COMMENT ON COLUMN "AlertRule"."windowMinutes" IS '评估窗口（分钟）';
COMMENT ON COLUMN "AlertRule"."cooldownMinutes" IS '告警冷却时间（分钟），避免重复通知';
COMMENT ON COLUMN "AlertRule"."severity" IS '严重级别：warning / critical';
COMMENT ON COLUMN "AlertRule"."enabled" IS '是否启用';
COMMENT ON COLUMN "AlertRule"."createdAt" IS '创建时间';
COMMENT ON COLUMN "AlertRule"."updatedAt" IS '更新时间';
COMMENT ON TABLE "AlertEvent" IS '告警事件表：规则的触发与恢复记录';
COMMENT ON COLUMN "AlertEvent"."id" IS '事件 ID';
COMMENT ON COLUMN "AlertEvent"."ruleId" IS '所属规则 ID';
COMMENT ON COLUMN "AlertEvent"."ruleName" IS '规则名称快照（规则删除后仍可追溯）';
COMMENT ON COLUMN "AlertEvent"."status" IS '事件状态：firing（告警中）/ resolved（已恢复）';
COMMENT ON COLUMN "AlertEvent"."value" IS '触发时的指标值';
COMMENT ON COLUMN "AlertEvent"."message" IS '告警描述';
COMMENT ON COLUMN "AlertEvent"."startedAt" IS '告警开始时间';
COMMENT ON COLUMN "AlertEvent"."resolvedAt" IS '恢复时间；未恢复为空';
COMMENT ON COLUMN "AlertEvent"."notifiedAt" IS '最近一次 webhook 通知时间';
COMMENT ON COLUMN "AlertEvent"."deliveryStatus" IS '通知投递状态：sent / failed / skipped';
COMMENT ON COLUMN "AlertEvent"."deliveryError" IS '投递失败原因';
COMMENT ON COLUMN "AlertEvent"."openKey" IS '未恢复事件唯一键：firing 为 ruleId，resolved 为 NULL，保证每条规则最多一个未恢复事件';
COMMENT ON COLUMN "AlertEvent"."createdAt" IS '创建时间';
COMMENT ON TABLE "Skill" IS '技能市场表：公共技能跨租户可见，个人技能仅创建者可见，可共享转为公共';
COMMENT ON COLUMN "Skill"."id" IS '技能 ID';
COMMENT ON COLUMN "Skill"."tenantId" IS '归属租户 ID；公共技能为空（跨租户）';
COMMENT ON COLUMN "Skill"."ownerUserId" IS '创建者用户 ID；运营端创建的公共技能为空';
COMMENT ON COLUMN "Skill"."scope" IS '可见范围：public（公共）/ personal（个人）';
COMMENT ON COLUMN "Skill"."name" IS '技能名称';
COMMENT ON COLUMN "Skill"."description" IS '一句话简介（市场列表展示）';
COMMENT ON COLUMN "Skill"."content" IS '技能正文：适用场景、步骤与注意事项，运行时拼接进系统提示词';
COMMENT ON COLUMN "Skill"."source" IS '来源：manual（手工创建）/ run（任务总结生成）';
COMMENT ON COLUMN "Skill"."sourceRunId" IS '生成该技能的运行 ID；手工创建为空';
COMMENT ON COLUMN "Skill"."sharedAt" IS '个人技能共享为公共的时间；未共享为空';
COMMENT ON COLUMN "Skill"."enabled" IS '是否启用；运营端可下架公共技能';
COMMENT ON COLUMN "Skill"."createdAt" IS '创建时间';
COMMENT ON COLUMN "Skill"."updatedAt" IS '更新时间';
