-- =============================================================================
-- AI 办公智能体 · 数据库 Schema（PostgreSQL 16）
-- -----------------------------------------------------------------------------
-- 本文件是 apps/bff/prisma/schema.prisma 的等价 DDL（29 张表），用于：
--   1) 首次建库的基线（无 Prisma 迁移历史时）；
--   2) 审阅数据模型 / 供 DBA 参考。
--
-- 权威来源：Prisma schema（当前无迁移历史，开发用 db push）。
--   常规变更请改 Prisma schema 并用 `prisma migrate`（生产）/`prisma db push`（开发），
--   再同步更新本文件，避免二者漂移。
--
-- 重新生成：
--   cd apps/bff
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
--   再补回文末的 pgvector 扩展与 HNSW 索引（Prisma 不生成 Unsupported 类型的索引）。
--
-- 应用方式：
--   psql "$DATABASE_URL" -f docs/db/schema.sql
--
-- 说明：
--   - 标识符大小写敏感，Prisma 使用模型/字段原样名，故全部加双引号。
--   - `gen_random_uuid()` 在 PostgreSQL 13+ 为内置函数，无需 pgcrypto 扩展。
--   - 时间戳对应 Prisma 的 TIMESTAMP(3)（毫秒精度，无时区）。
--   - 外键默认 ON DELETE RESTRICT ON UPDATE CASCADE（Prisma 默认行为）。
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
    "status" TEXT NOT NULL DEFAULT 'active',
    "model" TEXT,
    "assistantId" TEXT,
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

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "Session_tenantId_userId_idx" ON "Session"("tenantId", "userId");

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
