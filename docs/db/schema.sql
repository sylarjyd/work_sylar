-- =============================================================================
-- AI 办公智能体 · 数据库 Schema（PostgreSQL 16）
-- -----------------------------------------------------------------------------
-- 本文件是 apps/bff/prisma/schema.prisma 的等价 DDL，用于：
--   1) 首次建库的基线（无 Prisma 迁移历史时）；
--   2) 审阅数据模型 / 供 DBA 参考。
--
-- 权威来源：Prisma schema + 迁移文件（apps/bff/prisma/migrations）。
--   常规变更请改 Prisma schema 并用 `prisma migrate`（生产）/`prisma db push`（开发），
--   再同步更新本文件，避免二者漂移。
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

-- 可选：更老版本 Postgres 若缺 gen_random_uuid()
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- M4a 知识库：pgvector 扩展（镜像 pgvector/pgvector:pg16 自带）。
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- Tenant（租户 / 组织）
-- -----------------------------------------------------------------------------
CREATE TABLE "Tenant" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "type"      TEXT         NOT NULL DEFAULT 'personal',
    "name"      TEXT         NOT NULL,
    "plan"      TEXT         NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- User（用户）
-- -----------------------------------------------------------------------------
CREATE TABLE "User" (
    "id"           TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"     TEXT         NOT NULL,
    "email"        TEXT         NOT NULL,
    "passwordHash" TEXT         NOT NULL,
    "status"       TEXT         NOT NULL DEFAULT 'active',
    "role"         TEXT         NOT NULL DEFAULT 'member',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User" ("email");
CREATE INDEX "User_tenantId_idx" ON "User" ("tenantId");

ALTER TABLE "User"
    ADD CONSTRAINT "User_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Session（会话）
-- -----------------------------------------------------------------------------
CREATE TABLE "Session" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"  TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "title"     TEXT         NOT NULL DEFAULT '新会话',
    "status"    TEXT         NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Session_tenantId_userId_idx" ON "Session" ("tenantId", "userId");

ALTER TABLE "Session"
    ADD CONSTRAINT "Session_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Session"
    ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Message（对话消息）
-- -----------------------------------------------------------------------------
CREATE TABLE "Message" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" TEXT         NOT NULL,
    "role"      TEXT         NOT NULL,
    "content"   TEXT         NOT NULL,
    "seq"       INTEGER      NOT NULL,
    "tokens"    INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- 同一会话内 seq 唯一：保证消息顺序稳定、避免并发落库重号。
CREATE UNIQUE INDEX "Message_sessionId_seq_key" ON "Message" ("sessionId", "seq");

ALTER TABLE "Message"
    ADD CONSTRAINT "Message_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Task（用户下达的目标）
-- -----------------------------------------------------------------------------
CREATE TABLE "Task" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" TEXT         NOT NULL,
    "goal"      TEXT         NOT NULL,
    "status"    TEXT         NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Task_sessionId_idx" ON "Task" ("sessionId");

ALTER TABLE "Task"
    ADD CONSTRAINT "Task_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Run（一次 Agent 执行实例）
-- -----------------------------------------------------------------------------
CREATE TABLE "Run" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "taskId"    TEXT         NOT NULL,
    "status"    TEXT         NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"   TIMESTAMP(3),
    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Run_taskId_idx" ON "Run" ("taskId");

ALTER TABLE "Run"
    ADD CONSTRAINT "Run_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Step（Agent loop 单步：审计 / 回放数据源）
-- -----------------------------------------------------------------------------
CREATE TABLE "Step" (
    "id"      TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "runId"   TEXT         NOT NULL,
    "seq"     INTEGER      NOT NULL,
    "type"    TEXT         NOT NULL,  -- think | tool_call | tool_result | artifact | confirm_request
    "payload" JSONB        NOT NULL,
    "ts"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- 同一运行内 seq 唯一：对应的 SSE 事件序列与落库一一对齐。
CREATE UNIQUE INDEX "Step_runId_seq_key" ON "Step" ("runId", "seq");

ALTER TABLE "Step"
    ADD CONSTRAINT "Step_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Artifact（产出物元数据；字节在对象存储）
-- -----------------------------------------------------------------------------
CREATE TABLE "Artifact" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"   TEXT         NOT NULL,
    "sessionId"  TEXT         NOT NULL,
    "runId"      TEXT         NOT NULL,
    "kind"       TEXT         NOT NULL,  -- docx | xlsx | pptx
    "filename"   TEXT         NOT NULL,
    "storageKey" TEXT         NOT NULL,  -- artifacts/{tenantId}/{runId}/{uuid}-{filename}
    "size"       INTEGER      NOT NULL,
    "version"    INTEGER      NOT NULL DEFAULT 1,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Artifact_sessionId_idx" ON "Artifact" ("sessionId");
CREATE INDEX "Artifact_tenantId_idx"  ON "Artifact" ("tenantId");

ALTER TABLE "Artifact"
    ADD CONSTRAINT "Artifact_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Artifact"
    ADD CONSTRAINT "Artifact_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- KbDoc / KbChunk（M4a 知识库；向量维度固定 1024，须与 EMBEDDING_DIM 一致）
-- -----------------------------------------------------------------------------
CREATE TABLE "KbDoc" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"   TEXT         NOT NULL,
    "userId"     TEXT         NOT NULL,
    "filename"   TEXT         NOT NULL,
    "mime"       TEXT         NOT NULL,
    "size"       INTEGER      NOT NULL,
    "storageKey" TEXT         NOT NULL,
    "status"     TEXT         NOT NULL DEFAULT 'pending',  -- pending | ready | failed
    "chunkCount" INTEGER      NOT NULL DEFAULT 0,
    "error"      TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KbDoc_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KbDoc_tenantId_userId_idx" ON "KbDoc" ("tenantId", "userId");

CREATE TABLE "KbChunk" (
    "id"        TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "docId"     TEXT         NOT NULL,
    "tenantId"  TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "seq"       INTEGER      NOT NULL,
    "text"      TEXT         NOT NULL,
    "vector"    vector(1024) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KbChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KbChunk_docId_idx" ON "KbChunk" ("docId");
CREATE INDEX "KbChunk_tenantId_userId_idx" ON "KbChunk" ("tenantId", "userId");
CREATE INDEX "kb_chunk_vec_idx" ON "KbChunk" USING hnsw ("vector" vector_cosine_ops);

ALTER TABLE "KbChunk"
    ADD CONSTRAINT "KbChunk_docId_fkey"
    FOREIGN KEY ("docId") REFERENCES "KbDoc" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Connector（M4b MCP 连接器配置；envEncrypted 为 AES-256-GCM 密文，永不回传前端）
-- -----------------------------------------------------------------------------
CREATE TABLE "Connector" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"        TEXT         NOT NULL,
    "name"            TEXT         NOT NULL,
    "command"         TEXT         NOT NULL,
    "args"            JSONB        NOT NULL,
    "envEncrypted"    TEXT         NOT NULL,
    "enabled"         BOOLEAN      NOT NULL DEFAULT true,
    "toolCount"       INTEGER      NOT NULL DEFAULT 0,
    "lastValidatedAt" TIMESTAMP(3),
    "createdBy"       TEXT         NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Connector_tenantId_name_key" ON "Connector" ("tenantId", "name");
CREATE INDEX "Connector_tenantId_idx" ON "Connector" ("tenantId");

-- =============================================================================
-- 可选：生产加固（不在 Prisma schema 中，按需单独应用；应用后需同步维护）
-- -----------------------------------------------------------------------------
-- 1) Artifact 版本并发安全：当前 version 靠「查 max+1」计算，并发下可能重号
--    （见 docs/develop/05-dev-plan.md P1）。加唯一约束把冲突暴露为可重试的错误：
--
--    CREATE UNIQUE INDEX "Artifact_sessionId_filename_version_key"
--        ON "Artifact" ("sessionId", "filename", "version");
--
-- 2) 枚举列加 CHECK，防止脏值写入：
--
--    ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_kind_check"
--        CHECK ("kind" IN ('docx', 'xlsx', 'pptx'));
--    ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_size_check"
--        CHECK ("size" >= 0);
--    ALTER TABLE "Step" ADD CONSTRAINT "Step_type_check"
--        CHECK ("type" IN ('think', 'tool_call', 'tool_result', 'artifact', 'confirm_request'));
--    ALTER TABLE "Run"  ADD CONSTRAINT "Run_status_check"
--        CHECK ("status" IN ('running', 'done', 'failed'));
--    ALTER TABLE "Task" ADD CONSTRAINT "Task_status_check"
--        CHECK ("status" IN ('queued', 'running', 'done', 'failed'));
--
-- 3) 对象存储 Key 前缀不变量（tenantId/runId 隔离）在应用层校验；
--    如需库级兜底，可加 CHECK 约束 storageKey LIKE 'artifacts/%'。
-- =============================================================================
