# M5b-1 管理端（Admin Console）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付跨租户管理后台：用户、会员、会话、任务、模型价格、参数配置与审计，并把运行/KB 参数下发到 runtime。

**Architecture:** BFF 新增 `AdminModule`（全部路由 `/api/admin/*`，`JwtGuard + AdminGuard` 双重保护），鉴权改为每次请求查库校验用户状态并回填角色；写操作与审计同事务，敏感查看审计尽力而为。参数配置存 `Setting` 表，BFF 在每次 run / KB 摄取时解析生效值并通过 `RunRequest.config` 与 `/kb/ingest` 下发，runtime 二次夹取。Web 新增独立 `/admin` 后台。

**Tech Stack:** NestJS 10 + Fastify、Prisma 6（PostgreSQL）、Next.js 15 App Router、TypeScript、Vitest、pnpm + turbo。

**约定：** 本仓库直接在 `master` 分支开发，不使用特性分支/worktree；所有注释与 commit message 用中文。

---

## 文件结构

### BFF

- `apps/bff/prisma/schema.prisma`：新增 `Setting`、`AdminAuditLog`，补齐 `Tenant` 与 `Subscription`/`TenantCredit` 的关系。
- `apps/bff/src/auth/jwt.ts`、`jwt.guard.ts`、`admin.guard.ts`、`auth.service.ts`：鉴权重构。
- `apps/bff/src/audit/audit.types.ts`、`audit.service.ts`、`audit.module.ts`：审计写入与查询。
- `apps/bff/src/settings/settings.service.ts`、`settings.module.ts`：参数白名单、来源解析、更新/重置。
- `apps/bff/src/admin/`：管理端控制器与服务，一域一文件：
  - `admin.util.ts`（分页与查询参数）
  - `admin-users.controller.ts` / `admin-users.service.ts`
  - `admin-tenants.controller.ts` / `admin-tenants.service.ts`
  - `admin-plans.controller.ts` / `admin-plans.service.ts`
  - `admin-sessions.controller.ts` / `admin-sessions.service.ts`
  - `admin-tasks.controller.ts` / `admin-tasks.service.ts`
  - `admin-models.controller.ts` / `admin-models.service.ts`
  - `admin-settings.controller.ts`、`admin-audit.controller.ts`
  - `admin.module.ts`
- `apps/bff/src/tasks/tasks.controller.ts`：run 请求附带 `config`。
- `apps/bff/src/kb/kb.controller.ts`、`kb.service.ts`、`kb.module.ts`：KB 切分参数下发。

### Runtime

- `apps/agent-runtime/src/run-config.ts`：`RunRequest.config` 夹取。
- `apps/agent-runtime/src/server.ts`：按 run 解析参数、按请求解析 KB 切分参数。
- `apps/agent-runtime/src/agent-loop.ts`、`tools/types.ts`、`tools/code-exec.ts`：`codeExecTimeoutMs` 经 `RunContext` 生效。

### Shared

- `packages/shared/src/dto.ts`：管理端 DTO、分页、`RunConfig`。

### Web

- `apps/web/src/app/admin/layout.tsx`、`page.tsx`、`users/page.tsx`、`tenants/page.tsx`、`plans/page.tsx`、`sessions/page.tsx`、`tasks/page.tsx`、`models/page.tsx`、`settings/page.tsx`、`audit/page.tsx`。
- `apps/web/src/components/admin-shell.tsx`。
- `apps/web/src/lib/admin-api.ts`、`admin-guard.ts`。
- `apps/web/src/components/app-shell.tsx`：管理员入口。
- `apps/web/src/app/globals.css`：管理端样式。

---

## Task 1: 数据模型与共享 DTO

**Files:**
- Modify: `apps/bff/prisma/schema.prisma`
- Modify: `packages/shared/src/dto.ts`
- Test: `apps/bff/prisma/schema.prisma`（`prisma validate`）；shared 为纯类型改动，用 `build` 验证

- [ ] **Step 1: 新增 Prisma 模型与关系**

在 `apps/bff/prisma/schema.prisma` 的 `Tenant` 模型里补两个反向关系（用于管理端一次查询带出订阅与余额）：

```prisma
model Tenant {
  id        String   @id @default(uuid())
  type      String   @default("personal")
  name      String
  plan      String   @default("free")
  createdAt DateTime @default(now())
  users     User[]
  sessions  Session[]
  subscription Subscription?
  credit       TenantCredit?
}
```

给 `Subscription` 与 `TenantCredit` 补正向关系：

```prisma
model Subscription {
  id          String   @id @default(uuid())
  tenantId    String   @unique
  planId      String
  status      String   @default("active")
  periodStart DateTime
  periodEnd   DateTime
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  plan        Plan     @relation(fields: [planId], references: [id])
  tenant      Tenant   @relation(fields: [tenantId], references: [id])

  @@index([planId])
}

model TenantCredit {
  tenantId  String   @id
  balance   Int      @default(0)
  reserved  Int      @default(0)
  updatedAt DateTime @updatedAt
  tenant    Tenant   @relation(fields: [tenantId], references: [id])
}
```

在文件末尾追加两张新表：

```prisma
model Setting {
  key       String   @id
  value     Json
  updatedBy String?
  updatedAt DateTime @updatedAt
}

model AdminAuditLog {
  id         String   @id @default(uuid())
  actorId    String
  actorEmail String
  action     String
  targetType String
  targetId   String?
  summary    Json?
  ip         String?
  createdAt  DateTime @default(now())

  @@index([createdAt])
  @@index([targetType, targetId])
  @@index([actorId, createdAt])
}
```

- [ ] **Step 2: 校验并同步数据库**

Run: `pnpm --filter @ai-office/bff exec prisma validate`
Expected: `The schema at prisma\schema.prisma is valid 🚀`

Run: `pnpm --filter @ai-office/bff db:push`
Expected: 输出 `Your database is now in sync with your Prisma schema` 与注释脚本成功。

- [ ] **Step 3: 在 shared 增加分页与运行参数类型**

在 `packages/shared/src/dto.ts` 的 `RunRequest` 中增加可选字段：

```ts
export interface RunRequest {
  runId: string;
  sessionId: string;
  /** 产物存储 Key 需按租户隔离；BFF 从 JWT 取出后透传给 runtime。 */
  tenantId: string;
  /** 知识库按 tenant_id + user_id 隔离；BFF 从 JWT 的 sub 透传。 */
  userId: string;
  goal: string;
  messages: ChatMessage[];
  /** 预占额度、允许模型与价格；缺省表示不限预算（测试/兼容）。 */
  billing?: RunBilling;
  /** 管理端参数配置；缺省或非法值由 runtime 夹取。 */
  config?: RunConfig;
}
```

在文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// M5b-1 管理端
// ---------------------------------------------------------------------------

/** 管理端统一 offset 分页响应。 */
export interface PageDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type UserStatus = 'active' | 'disabled';
export type UserRole = 'member' | 'admin';

export interface AdminUserItemDto {
  id: string;
  email: string;
  tenantId: string;
  tenantName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface AdminUserDetailDto extends AdminUserItemDto {
  planId: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  balance: number;
  reserved: number;
  sessionCount: number;
}

export interface AdminUserPatch {
  status?: UserStatus;
  role?: UserRole;
}

export interface AdminTenantItemDto {
  id: string;
  name: string;
  type: string;
  planId: string;
  planName: string;
  subscriptionStatus: string;
  balance: number;
  reserved: number;
  userCount: number;
  createdAt: string;
}

export interface AdminTenantDetailDto extends AdminTenantItemDto {
  sessionCount: number;
  billing: BillingSummaryDto;
}

export interface AdminPlanDto extends PlanDto {
  active: boolean;
  createdAt: string;
}

export interface AdminPlanInput {
  id: string;
  name: string;
  priceCents: number;
  monthlyBaseCredits: number;
  monthlyBonusCredits: number;
  maxCreditsPerRun: number;
  rpm: number;
  allowedModels: string[];
  active: boolean;
}

export type AdminPlanPatch = Partial<Omit<AdminPlanInput, 'id'>>;

export interface AdminSessionItemDto {
  id: string;
  title: string;
  status: string;
  tenantId: string;
  userEmail: string;
  messageCount: number;
  taskCount: number;
  createdAt: string;
}

export interface AdminSessionDetailDto extends AdminSessionItemDto {
  artifactCount: number;
}

export interface AdminMessageDto extends MessageDto {
  createdAt: string;
}

export interface AdminTaskItemDto {
  id: string;
  sessionId: string;
  goal: string;
  status: string;
  latestRunStatus: string | null;
  createdAt: string;
}

export interface AdminRunItemDto {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  credits: number | null;
}

export interface AdminTaskDetailDto extends AdminTaskItemDto {
  runs: AdminRunItemDto[];
}

export interface AdminStepDto {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface AdminRunDetailDto {
  id: string;
  taskId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  steps: PageDto<AdminStepDto>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    credits: number | null;
    status: string;
    models: unknown;
  } | null;
}

export interface AdminModelProviderDto {
  /** provider 标识（取 apiKeyEnv 名；单模型配置为 default）；不含任何密钥。 */
  name: string;
  models: string[];
}

export interface AdminModelPriceDto extends ModelPriceDto {
  model: string;
  updatedAt: string;
}

export interface AdminModelsDto {
  providers: AdminModelProviderDto[];
  prices: AdminModelPriceDto[];
}

export type SettingSource = 'db' | 'env' | 'default';

export interface AdminSettingDto {
  key: string;
  value: number;
  source: SettingSource;
  updatedAt: string | null;
  updatedBy: string | null;
  min: number;
  max: number;
}

export interface AdminAuditItemDto {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AdminSubscribeRequest {
  planId: string;
}

export interface AdminCreditsRequest {
  amount: number;
  note?: string;
  expiresAt?: string | null;
}

/** 运行参数（BFF → runtime）；缺省或非法值由 runtime 夹取。 */
export interface RunConfig {
  maxRounds?: number;
  confirmTimeoutMs?: number;
  codeExecTimeoutMs?: number;
}
```

- [ ] **Step 4: 构建 shared**

Run: `pnpm --filter @ai-office/shared build`
Expected: `ESM dist/index.js` 与 `DTS dist/index.d.ts` 构建成功。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/prisma/schema.prisma packages/shared/src/dto.ts
git commit -m "feat(bff): 新增管理端配置与审计数据模型及共享 DTO"
```

---

## Task 2: 鉴权重构（查库校验状态与角色）

**Files:**
- Modify: `apps/bff/src/auth/jwt.ts`
- Modify: `apps/bff/src/auth/jwt.guard.ts`
- Modify: `apps/bff/src/auth/admin.guard.ts`
- Modify: `apps/bff/src/auth/auth.service.ts`
- Test: `apps/bff/src/auth/jwt.guard.test.ts`
- Test: `apps/bff/src/auth/admin.guard.test.ts`
- Test: `apps/bff/src/auth/auth.controller.test.ts`
- Test: `apps/bff/src/{sessions,tasks,runs,artifacts,connector,kb}/*.controller.test.ts`（补假库）

- [ ] **Step 1: 先改测试（会失败）**

把 `apps/bff/src/auth/jwt.guard.test.ts` 整体替换为：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { signToken } from './jwt';
import type { PrismaService } from '../db/prisma.service';

function ctxWithAuthHeader(header?: string): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; user?: unknown };
} {
  const req: { headers: Record<string, string>; user?: unknown } = { headers: {} };
  if (header !== undefined) req.headers.authorization = header;
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

function guardWith(
  user: { status: string; role: string; tenantId: string; email: string } | null,
): JwtGuard {
  const prisma = { user: { findUnique: async () => user } } as unknown as PrismaService;
  return new JwtGuard(prisma);
}

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

describe('JwtGuard', () => {
  it('缺少 Authorization 头时抛 missing_token', async () => {
    const { ctx } = ctxWithAuthHeader();
    await expect(guardWith(null).canActivate(ctx)).rejects.toMatchObject({ message: 'missing_token' });
  });

  it('被篡改的 token 抛 invalid_token', async () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}x`);
    await expect(guardWith(null).canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('启用用户放行，并用库中角色/邮箱回填 req.user', async () => {
    const { ctx, req } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    const guard = guardWith({ status: 'active', role: 'admin', tenantId: 't1', email: 'a@b.c' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'u1', tenantId: 't1', role: 'admin', email: 'a@b.c' });
  });

  it('禁用用户 401', async () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    const guard = guardWith({ status: 'disabled', role: 'member', tenantId: 't1', email: 'a@b.c' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ message: 'invalid_token' });
  });

  it('用户不存在 401', async () => {
    const { ctx } = ctxWithAuthHeader(`Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}`);
    await expect(guardWith(null).canActivate(ctx)).rejects.toMatchObject({ message: 'invalid_token' });
  });
});
```

把 `apps/bff/src/auth/admin.guard.test.ts` 整体替换为：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function ctxWithUser(user?: { sub: string; tenantId: string; role?: string }): ExecutionContext {
  const req: { user?: { sub: string; tenantId: string; role?: string } } = user ? { user } : {};
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  it('req.user.role 为 admin 时放行', () => {
    expect(new AdminGuard().canActivate(ctxWithUser({ sub: 'u1', tenantId: 't1', role: 'admin' }))).toBe(true);
  });

  it('非管理员抛 Forbidden not_admin', () => {
    const err = (() => {
      try {
        new AdminGuard().canActivate(ctxWithUser({ sub: 'u2', tenantId: 't1', role: 'member' }));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe('not_admin');
  });

  it('未经过 JwtGuard（无 req.user）抛 Forbidden', () => {
    expect(() => new AdminGuard().canActivate(ctxWithUser())).toThrow(ForbiddenException);
  });
});
```

在 `apps/bff/src/auth/auth.controller.test.ts` 中，给 `FakeUser` 加 `status: string`，给 `seedUser` 补 `status: 'active'`，并新增用例：

```ts
  it('禁用用户即使密码正确也返回 401', async () => {
    await seedUser('disabled@b.com', 'pw123456');
    const row = users.get('disabled@b.com')!;
    users.set('disabled@b.com', { ...row, status: 'disabled' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'disabled@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).message).toBe('invalid_credentials');
  });
```

> 后续 controller 测试的假库都缺 `user.findUnique`，这是本步骤要一并补的（见 Step 3）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/auth`
Expected: FAIL —— `JwtGuard` 构造器不接受参数 / 禁用用户仍登录成功。

- [ ] **Step 3: 实现鉴权重构**

`apps/bff/src/auth/jwt.ts`：

```ts
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  /** 以下字段由 JwtGuard 查库回填，签名 payload 中不含。 */
  role?: string;
  email?: string;
}

/** 每次调用读取 env：测试在 beforeAll 里设置 JWT_SECRET，模块级读取会拿到旧值。 */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET 未设置');
  return s;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(
    { sub: payload.sub, tenantId: payload.tenantId },
    secret(),
    { algorithm: 'HS256', expiresIn: '7d' },
  );
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret(), { algorithms: ['HS256'] }) as JwtPayload;
}
```

`apps/bff/src/auth/jwt.guard.ts`：

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../db/prisma.service';
import { verifyToken, type JwtPayload } from './jwt';

export interface AuthedRequest extends FastifyRequest {
  user: JwtPayload;
}

/**
 * Bearer JWT 鉴权：验签后按 sub 查库，要求用户存在且 status=active，
 * 再把库中的 tenantId/role/email 挂到 req.user。
 * 禁用立即生效（含已签发 token），角色变更无需重发 token。
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing_token');

    let payload: JwtPayload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new UnauthorizedException('invalid_token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, role: true, tenantId: true, email: true },
    });
    // 不存在/禁用统一 invalid_token，避免给攻击者额外信号。
    if (!user || user.status !== 'active') throw new UnauthorizedException('invalid_token');

    req.user = {
      sub: payload.sub,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    };
    return true;
  }
}
```

`apps/bff/src/auth/admin.guard.ts`：

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthedRequest } from './jwt.guard';

/**
 * 管理员校验：只读 JwtGuard 回填的 role，不再查库。
 * **须置于 JwtGuard 之后**（`@UseGuards(JwtGuard, AdminGuard)`）。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Partial<AuthedRequest>>();
    if (req.user?.role !== 'admin') throw new ForbiddenException('not_admin');
    return true;
  }
}
```

`apps/bff/src/auth/auth.service.ts` 的 `login` 改为：

```ts
  async login(req: LoginRequest): Promise<AuthResponse> {
    const email = normalizeEmail(req.email);
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    // 先验密码再看状态：邮箱不存在、密码错误、账号禁用统一 invalid_credentials，避免账号枚举。
    const passwordOk = user ? await argon2.verify(user.passwordHash, req.password) : false;
    if (!user || !passwordOk || user.status !== 'active') {
      throw new UnauthorizedException('invalid_credentials');
    }
    return this.issue(user.id, user.tenantId, user.email, user.role);
  }
```

- [ ] **Step 4: 给既有 controller 测试补假库用户**

以下文件里的 `fakePrisma` 对象需要增加 `user.findUnique`（JwtGuard 现在会查库）。每个文件补在对象字面量最前面：

```ts
  user: {
    // JwtGuard 会按 sub 查库校验 status/role；测试里按 token 中的 sub 返回对应租户。
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'u2' ? 'member' : 'admin',
      tenantId: where.id === 'u2' ? 't2' : 't1',
      email: `${where.id}@test.local`,
    }),
  },
```

应用文件：

- `apps/bff/src/sessions/sessions.controller.test.ts`
- `apps/bff/src/tasks/tasks.controller.test.ts`
- `apps/bff/src/runs/runs.controller.test.ts`
- `apps/bff/src/artifacts/artifacts.controller.test.ts`
- `apps/bff/src/connector/connector.controller.test.ts`
- `apps/bff/src/kb/kb.controller.test.ts`（该文件还需要在测试模块 `providers` 中补 `{ provide: PrismaService, useValue: fakePrisma }`，否则 Nest 无法实例化 JwtGuard）

若某个测试使用了 `u1/t1`、`u2/t2` 之外的 sub，按该文件实际常量扩展映射。

- [ ] **Step 5: 运行 BFF 测试**

Run: `pnpm --filter @ai-office/bff test`
Expected: 全部通过（含新增的禁用用户、查库角色用例）。

- [ ] **Step 6: 提交**

```bash
git add apps/bff/src/auth apps/bff/src/sessions/sessions.controller.test.ts apps/bff/src/tasks/tasks.controller.test.ts apps/bff/src/runs/runs.controller.test.ts apps/bff/src/artifacts/artifacts.controller.test.ts apps/bff/src/connector/connector.controller.test.ts apps/bff/src/kb/kb.controller.test.ts
git commit -m "refactor(auth): JwtGuard 改为查库校验用户状态并回填角色"
```

---

## Task 3: 审计服务

**Files:**
- Create: `apps/bff/src/audit/audit.types.ts`
- Create: `apps/bff/src/audit/audit.service.ts`
- Create: `apps/bff/src/audit/audit.module.ts`
- Create: `apps/bff/src/admin/admin.util.ts`
- Test: `apps/bff/src/audit/audit.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/audit/audit.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { AuditService } from './audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from './audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local', ip: '127.0.0.1' };

function makeService(createImpl: (args: unknown) => Promise<unknown>) {
  const prisma = {
    adminAuditLog: {
      create: createImpl,
      findMany: async () => [
        {
          id: 'l1',
          actorId: 'a1',
          actorEmail: 'admin@test.local',
          action: 'user.update',
          targetType: 'user',
          targetId: 'u1',
          summary: { ok: true },
          ip: '127.0.0.1',
          createdAt: new Date('2026-10-19T00:00:00Z'),
        },
      ],
      count: async () => 1,
    },
  } as unknown as PrismaService;
  return new AuditService(prisma);
}

describe('AuditService', () => {
  it('write 把 actor 与 entry 落成一行', async () => {
    const created: unknown[] = [];
    const svc = makeService(async (args) => {
      created.push(args);
      return {};
    });
    await svc.write({} as never, actor, {
      action: 'user.update',
      targetType: 'user',
      targetId: 'u1',
      summary: { before: 1 },
    });
    expect(created[0]).toMatchObject({
      data: {
        actorId: 'a1',
        actorEmail: 'admin@test.local',
        action: 'user.update',
        targetType: 'user',
        targetId: 'u1',
        summary: { before: 1 },
        ip: '127.0.0.1',
      },
    });
  });

  it('bestEffort 写失败不抛出', async () => {
    const svc = makeService(async () => {
      throw new Error('db down');
    });
    await expect(
      svc.bestEffort(actor, { action: 'user.view', targetType: 'user', targetId: 'u1' }),
    ).resolves.toBeUndefined();
  });

  it('list 返回分页与 ISO 时间', async () => {
    const svc = makeService(async () => ({}));
    const page = await svc.list({ page: '1', pageSize: '20', action: 'user.update' });
    expect(page.total).toBe(1);
    expect(page.items[0].createdAt).toBe('2026-10-19T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/audit`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现工具与控制台审计**

`apps/bff/src/admin/admin.util.ts`：

```ts
import { BadRequestException } from '@nestjs/common';

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

function parseIntParam(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequestException(code);
  return n;
}

/** 统一 offset 分页：page ≥ 1，pageSize 1–100，缺省 20。 */
export function parsePage(page?: unknown, pageSize?: unknown): PageParams {
  const p = parseIntParam(page, 1, 1, 1_000_000, 'invalid_page');
  const s = parseIntParam(pageSize, 20, 1, 100, 'invalid_page_size');
  return { page: p, pageSize: s, skip: (p - 1) * s, take: s };
}

export function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v === '' ? undefined : v;
}

export function optionalDate(raw: unknown, code: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException(code);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(code);
  return d;
}
```

`apps/bff/src/audit/audit.types.ts`：

```ts
import type { JwtPayload } from '../auth/jwt';

/** 管理操作发起人：来自 JwtGuard 回填的 req.user + 请求来源 IP。 */
export interface AdminActor {
  id: string;
  email: string;
  ip?: string;
}

export function actorOf(user: JwtPayload, req: { ip?: string }): AdminActor {
  return { id: user.sub, email: user.email ?? '', ip: req.ip };
}
```

`apps/bff/src/audit/audit.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AdminAuditItemDto, PageDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { optionalDate, optionalString, parsePage } from '../admin/admin.util';
import type { AdminActor } from './audit.types';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  summary?: Record<string, unknown> | null;
}

type Db = Prisma.TransactionClient;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 写操作审计：必须与业务写入同事务，失败即整体回滚。 */
  async write(tx: Db, actor: AdminActor, entry: AuditEntry): Promise<void> {
    await tx.adminAuditLog.create({ data: toData(actor, entry) });
  }

  /** 敏感查看审计：读取成功后调用；写失败只记日志，不阻断读取。 */
  async bestEffort(actor: AdminActor, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({ data: toData(actor, entry) });
    } catch (err) {
      this.logger.warn(`审计写入失败 action=${entry.action}: ${(err as Error).message}`);
    }
  }

  async list(query: Record<string, unknown>): Promise<PageDto<AdminAuditItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const action = optionalString(query.action);
    const targetType = optionalString(query.targetType);
    const targetId = optionalString(query.targetId);
    const actorId = optionalString(query.actorId);
    const from = optionalDate(query.from, 'invalid_from');
    const to = optionalDate(query.to, 'invalid_to');

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(actorId ? { actorId } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        summary: (r.summary ?? null) as Record<string, unknown> | null,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }
}

function toData(actor: AdminActor, entry: AuditEntry): Prisma.AdminAuditLogUncheckedCreateInput {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    summary:
      entry.summary === undefined || entry.summary === null
        ? undefined
        : (entry.summary as Prisma.InputJsonValue),
    ip: actor.ip ?? null,
  };
}
```

`apps/bff/src/audit/audit.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/audit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/audit apps/bff/src/admin/admin.util.ts
git commit -m "feat(bff): 新增管理端审计服务"
```

---

## Task 4: 参数配置服务

**Files:**
- Create: `apps/bff/src/settings/settings.service.ts`
- Create: `apps/bff/src/settings/settings.module.ts`
- Test: `apps/bff/src/settings/settings.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/settings/settings.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

type Row = { key: string; value: unknown; updatedBy: string | null; updatedAt: Date };

function makeService() {
  const rows = new Map<string, Row>();
  const audits: unknown[] = [];
  const db = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null,
      upsert: async ({ where, create, update }: {
        where: { key: string };
        create: { key: string; value: unknown; updatedBy?: string };
        update: { value: unknown; updatedBy?: string };
      }) => {
        const row: Row = {
          key: where.key,
          value: 'value' in update ? update.value : create.value,
          updatedBy: 'updatedBy' in update ? (update.updatedBy ?? null) : (create.updatedBy ?? null),
          updatedAt: new Date('2026-10-19T00:00:00Z'),
        };
        rows.set(where.key, row);
        return row;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        const existed = rows.delete(where.key);
        return { count: existed ? 1 : 0 };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
        return {};
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  return { svc: new SettingsService(db), rows, audits };
}

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

beforeEach(() => {
  process.env.CONFIRM_TIMEOUT_MS = '60000';
  delete process.env.CODE_EXEC_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.CONFIRM_TIMEOUT_MS;
});

describe('SettingsService', () => {
  it('无 DB 覆盖时按 env → 默认值解析来源', async () => {
    const { svc } = makeService();
    const all = await svc.getAll();
    const confirm = all.find((s) => s.key === 'confirmTimeoutMs')!;
    const exec = all.find((s) => s.key === 'codeExecTimeoutMs')!;
    expect(confirm).toMatchObject({ value: 60000, source: 'env' });
    expect(exec).toMatchObject({ value: 5000, source: 'default' });
  });

  it('DB 覆盖优先于 env', async () => {
    const { svc } = makeService();
    await svc.update('confirmTimeoutMs', 30000, actor);
    const item = (await svc.getAll()).find((s) => s.key === 'confirmTimeoutMs')!;
    expect(item).toMatchObject({ value: 30000, source: 'db' });
  });

  it('越界值抛 invalid_value', async () => {
    const { svc } = makeService();
    await expect(svc.update('maxRounds', 33, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('maxRounds', 1.5, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('kbChunkOverlap 必须小于生效的 kbChunkSize', async () => {
    const { svc } = makeService();
    await svc.update('kbChunkSize', 500, actor);
    await expect(svc.update('kbChunkOverlap', 500, actor)).rejects.toMatchObject({
      message: 'invalid_kbChunkOverlap',
    });
    await expect(svc.update('kbChunkOverlap', 200, actor)).resolves.toMatchObject({ value: 200 });
  });

  it('update 与审计同事务写入', async () => {
    const { svc, audits } = makeService();
    await svc.update('maxRounds', 12, actor);
    expect(audits[0]).toMatchObject({
      action: 'setting.update',
      targetType: 'setting',
      targetId: 'maxRounds',
      actorId: 'a1',
    });
  });

  it('reset 删除覆盖后回到 env/默认来源', async () => {
    const { svc } = makeService();
    await svc.update('confirmTimeoutMs', 30000, actor);
    const item = await svc.reset('confirmTimeoutMs', actor);
    expect(item).toMatchObject({ value: 60000, source: 'env' });
  });

  it('getRunConfig / getKbConfig 返回具体数值', async () => {
    const { svc } = makeService();
    await expect(svc.getRunConfig()).resolves.toEqual({
      maxRounds: 8,
      confirmTimeoutMs: 60000,
      codeExecTimeoutMs: 5000,
    });
    await expect(svc.getKbConfig()).resolves.toEqual({ chunkSize: 800, chunkOverlap: 150 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/settings`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 SettingsService**

`apps/bff/src/settings/settings.service.ts`：

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminSettingDto, RunConfig, SettingSource } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

export interface SettingSpec {
  min: number;
  max: number;
  fallback: number;
  env?: string;
}

export const SETTING_SPECS: Record<string, SettingSpec> = {
  maxRounds: { min: 1, max: 32, fallback: 8 },
  confirmTimeoutMs: { min: 1000, max: 600000, fallback: 120000, env: 'CONFIRM_TIMEOUT_MS' },
  codeExecTimeoutMs: { min: 100, max: 60000, fallback: 5000, env: 'CODE_EXEC_TIMEOUT_MS' },
  kbChunkSize: { min: 100, max: 4000, fallback: 800, env: 'KB_CHUNK_SIZE' },
  kbChunkOverlap: { min: 0, max: 1000, fallback: 150, env: 'KB_CHUNK_OVERLAP' },
};

export type SettingKey = keyof typeof SETTING_SPECS;

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_SPECS, value);
}

interface Resolved {
  value: number;
  source: SettingSource;
  updatedAt: Date | null;
  updatedBy: string | null;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getAll(): Promise<AdminSettingDto[]> {
    return Promise.all((Object.keys(SETTING_SPECS) as SettingKey[]).map((key) => this.toDto(key)));
  }

  async getRunConfig(): Promise<Required<RunConfig>> {
    const [maxRounds, confirmTimeoutMs, codeExecTimeoutMs] = await Promise.all([
      this.resolve('maxRounds'),
      this.resolve('confirmTimeoutMs'),
      this.resolve('codeExecTimeoutMs'),
    ]);
    return {
      maxRounds: maxRounds.value,
      confirmTimeoutMs: confirmTimeoutMs.value,
      codeExecTimeoutMs: codeExecTimeoutMs.value,
    };
  }

  async getKbConfig(): Promise<{ chunkSize: number; chunkOverlap: number }> {
    const size = await this.resolve('kbChunkSize');
    const overlap = await this.resolve('kbChunkOverlap');
    // 脏 env 与 DB 组合也可能出现 overlap ≥ size；回落到默认 overlap 并保证小于 size。
    const chunkOverlap =
      overlap.value < size.value
        ? overlap.value
        : Math.min(SETTING_SPECS.kbChunkOverlap.fallback, Math.max(0, size.value - 1));
    return { chunkSize: size.value, chunkOverlap };
  }

  async update(key: string, raw: unknown, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    const value = this.validate(key, raw);

    if (key === 'kbChunkOverlap') {
      const size = await this.resolve('kbChunkSize');
      if (value >= size.value) throw new BadRequestException('invalid_kbChunkOverlap');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key },
        create: { key, value, updatedBy: actor.id },
        update: { value, updatedBy: actor.id },
      });
      await this.audit.write(tx, actor, {
        action: 'setting.update',
        targetType: 'setting',
        targetId: key,
        summary: { value },
      });
    });
    return this.toDto(key);
  }

  async reset(key: string, actor: AdminActor): Promise<AdminSettingDto> {
    if (!isSettingKey(key)) throw new NotFoundException('setting_not_found');
    await this.prisma.$transaction(async (tx) => {
      await tx.setting.deleteMany({ where: { key } });
      await this.audit.write(tx, actor, {
        action: 'setting.reset',
        targetType: 'setting',
        targetId: key,
      });
    });
    return this.toDto(key);
  }

  private validate(key: SettingKey, raw: unknown): number {
    const spec = SETTING_SPECS[key];
    if (
      typeof raw !== 'number' ||
      !Number.isSafeInteger(raw) ||
      raw < spec.min ||
      raw > spec.max
    ) {
      throw new BadRequestException('invalid_value');
    }
    return raw;
  }

  private async resolve(key: SettingKey): Promise<Resolved> {
    const spec = SETTING_SPECS[key];
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (
      row &&
      typeof row.value === 'number' &&
      Number.isSafeInteger(row.value) &&
      row.value >= spec.min &&
      row.value <= spec.max
    ) {
      return {
        value: row.value,
        source: 'db',
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    }

    if (spec.env) {
      const envValue = Number(process.env[spec.env]);
      if (Number.isSafeInteger(envValue) && envValue >= spec.min && envValue <= spec.max) {
        return { value: envValue, source: 'env', updatedAt: null, updatedBy: null };
      }
    }

    return { value: spec.fallback, source: 'default', updatedAt: null, updatedBy: null };
  }

  private async toDto(key: SettingKey): Promise<AdminSettingDto> {
    const resolved = await this.resolve(key);
    const spec = SETTING_SPECS[key];
    return {
      key,
      value: resolved.value,
      source: resolved.source,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedBy: resolved.updatedBy,
      min: spec.min,
      max: spec.max,
    };
  }
}
```

`apps/bff/src/settings/settings.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuditModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/settings`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/settings
git commit -m "feat(bff): 新增参数配置服务与生效值解析"
```

---

## Task 5: 管理端用户接口

**Files:**
- Create: `apps/bff/src/admin/admin-users.service.ts`
- Create: `apps/bff/src/admin/admin-users.controller.ts`
- Test: `apps/bff/src/admin/admin-users.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/admin/admin-users.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'admin1', email: 'admin@test.local' };

interface Row {
  id: string;
  email: string;
  tenantId: string;
  role: string;
  status: string;
  createdAt: Date;
  tenant: { name: string };
}

function makeService(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  const audits: unknown[] = [];
  const db = {
    user: {
      findMany: async () => rows,
      count: async () => rows.length,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    subscription: { findUnique: async () => null },
    tenantCredit: { findUnique: async () => null },
    session: { count: async () => 3 },
    adminAuditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
        return {};
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminUsersService(db, audit), rows, audits };
}

function user(overrides: Partial<Row> = {}): Row {
  return {
    id: 'u1',
    email: 'u1@test.local',
    tenantId: 't1',
    role: 'member',
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    tenant: { name: '个人空间' },
    ...overrides,
  };
}

describe('AdminUsersService', () => {
  it('list 返回分页结构', async () => {
    const { svc } = makeService([user()]);
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ email: 'u1@test.local', tenantName: '个人空间' });
  });

  it('detail 返回计费摘要与会话数并记 user.view', async () => {
    const { svc, audits } = makeService([user()]);
    const detail = await svc.detail('u1', actor);
    expect(detail).toMatchObject({ sessionCount: 3, balance: 0, reserved: 0 });
    expect(audits[0]).toMatchObject({ action: 'user.view', targetId: 'u1' });
  });

  it('不能修改自己', async () => {
    const { svc } = makeService([user({ id: 'admin1', email: 'admin@test.local', role: 'admin' })]);
    await expect(svc.update('admin1', { status: 'disabled' }, actor)).rejects.toMatchObject({
      message: 'cannot_modify_self',
    });
  });

  it('不能移除最后一个 active 管理员', async () => {
    const { svc } = makeService([user({ id: 'u1', role: 'admin' })]);
    await expect(svc.update('u1', { role: 'member' }, actor)).rejects.toMatchObject({
      message: 'last_admin',
    });
  });

  it('还有其他管理员时允许降级，并写 user.update 审计', async () => {
    const { svc, audits } = makeService([
      user({ id: 'u1', role: 'admin' }),
      user({ id: 'u2', email: 'u2@test.local', role: 'admin' }),
    ]);
    const out = await svc.update('u1', { role: 'member' }, actor);
    expect(out.role).toBe('member');
    expect(audits.at(-1)).toMatchObject({ action: 'user.update', targetId: 'u1' });
  });

  it('非法状态/角色抛 400', async () => {
    const { svc } = makeService([user()]);
    await expect(svc.update('u1', { status: 'deleted' }, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('u1', { role: 'owner' }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('用户不存在抛 404', async () => {
    const { svc } = makeService([]);
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-users`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现服务与控制器**

`apps/bff/src/admin/admin-users.service.ts`：

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  PageDto,
  UserRole,
  UserStatus,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { optionalString, parsePage } from './admin.util';

interface UserRow {
  id: string;
  email: string;
  tenantId: string;
  role: string;
  status: string;
  createdAt: Date;
  tenant: { name: string };
}

function isStatus(v: unknown): v is UserStatus {
  return v === 'active' || v === 'disabled';
}

function isRole(v: unknown): v is UserRole {
  return v === 'member' || v === 'admin';
}

function toItem(row: UserRow): AdminUserItemDto {
  return {
    id: row.id,
    email: row.email,
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminUserItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const q = optionalString(query.q);
    const status = optionalString(query.status);
    const role = optionalString(query.role);
    if (status !== undefined && !isStatus(status)) throw new BadRequestException('invalid_status');
    if (role !== undefined && !isRole(role)) throw new BadRequestException('invalid_role');

    const where: Prisma.UserWhereInput = {
      ...(q ? { email: { contains: q, mode: 'insensitive' } } : {}),
      ...(status ? { status } : {}),
      ...(role ? { role } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { tenant: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: rows.map(toItem), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminUserDetailDto> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('user_not_found');

    const [sub, credit, sessionCount] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { tenantId: row.tenantId },
        include: { plan: { select: { id: true, name: true } } },
      }),
      this.prisma.tenantCredit.findUnique({ where: { tenantId: row.tenantId } }),
      this.prisma.session.count({ where: { userId: id } }),
    ]);

    await this.audit.bestEffort(actor, {
      action: 'user.view',
      targetType: 'user',
      targetId: id,
    });

    return {
      ...toItem(row),
      planId: sub?.plan.id ?? null,
      planName: sub?.plan.name ?? null,
      subscriptionStatus: sub?.status ?? null,
      balance: Math.max(0, (credit?.balance ?? 0) - (credit?.reserved ?? 0)),
      reserved: credit?.reserved ?? 0,
      sessionCount,
    };
  }

  async update(id: string, patch: AdminUserPatch, actor: AdminActor): Promise<AdminUserItemDto> {
    // 自我保护先于存在性检查：即使是伪造 id 也不能绕过。
    if (id === actor.id) throw new BadRequestException('cannot_modify_self');

    const status = patch?.status;
    const role = patch?.role;
    if (status === undefined && role === undefined) throw new BadRequestException('invalid_patch');
    if (status !== undefined && !isStatus(status)) throw new BadRequestException('invalid_status');
    if (role !== undefined && !isRole(role)) throw new BadRequestException('invalid_role');

    const row = await this.prisma.user.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('user_not_found');

    const next: { status: UserStatus; role: UserRole } = {
      status: status ?? (row.status as UserStatus),
      role: role ?? (row.role as UserRole),
    };

    // 只检查「从 active admin 变为非 active admin」的情况，覆盖禁用与降级。
    if (row.role === 'admin' && (next.status !== 'active' || next.role !== 'admin')) {
      const others = await this.prisma.user.count({
        where: { id: { not: id }, role: 'admin', status: 'active' },
      });
      if (others === 0) throw new BadRequestException('last_admin');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: next });
      await this.audit.write(tx, actor, {
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        summary: {
          before: { status: row.status, role: row.role },
          after: next,
        },
      });
    });

    return { ...toItem(row), status: next.status, role: next.role };
  }
}
```

`apps/bff/src/admin/admin-users.controller.ts`：

```ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminUsersService } from './admin-users.service';

@Controller('api/admin/users')
@UseGuards(JwtGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminUserItemDto>> {
    return this.users.list(query ?? {});
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminUserDetailDto> {
    return this.users.detail(id, actorOf(user, req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminUserPatch,
  ): Promise<AdminUserItemDto> {
    return this.users.update(id, body ?? {}, actorOf(user, req));
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-users`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/admin/admin-users.service.ts apps/bff/src/admin/admin-users.controller.ts apps/bff/src/admin/admin-users.service.test.ts
git commit -m "feat(bff): 新增管理端用户接口"
```

---

## Task 6: 管理端租户/会员接口

**Files:**
- Create: `apps/bff/src/admin/admin-tenants.service.ts`
- Create: `apps/bff/src/admin/admin-tenants.controller.ts`
- Modify: `apps/bff/src/billing/billing.service.ts`（写事务审计钩子）
- Test: `apps/bff/src/admin/admin-tenants.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/admin/admin-tenants.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminTenantsService } from './admin-tenants.service';
import type { AuditService } from '../audit/audit.service';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'admin1', email: 'admin@test.local' };
const summary = {
  plan: {
    id: 'pro', name: '专业版', priceCents: 9900, monthlyBaseCredits: 1000,
    monthlyBonusCredits: 0, maxCreditsPerRun: 100, rpm: 10, allowedModels: ['m'],
  },
  subscription: { status: 'active', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z' },
  balance: 900,
  reserved: 100,
  nextExpiry: null,
};

function makeService(exists = true) {
  const audits: unknown[] = [];
  const db = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        exists && where.id === 't1'
          ? {
              id: 't1', name: '团队', type: 'personal', createdAt: new Date('2026-01-01T00:00:00Z'),
              subscription: { planId: 'pro', status: 'active', plan: { name: '专业版' } },
              credit: { balance: 1000, reserved: 100 },
              _count: { users: 2 },
            }
          : null,
      findMany: async () => [{
        id: 't1', name: '团队', type: 'personal', createdAt: new Date('2026-01-01T00:00:00Z'),
        subscription: { planId: 'pro', status: 'active', plan: { name: '专业版' } },
        credit: { balance: 1000, reserved: 100 },
        _count: { users: 2 },
      }],
      count: async () => 1,
    },
    session: { count: async () => 4 },
    adminAuditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  const billing = {
    adminSubscribe: vi.fn(async (_tenantId: string, _planId: string, _now: Date, hook?: (tx: unknown) => Promise<void>) => {
      await hook?.({});
      return summary;
    }),
    adjust: vi.fn(async (_tenantId: string, _amount: number, _note: string, _exp: Date | null, hook?: (tx: unknown) => Promise<void>) => {
      await hook?.({});
      return summary;
    }),
    summary: vi.fn(async () => summary),
  } as unknown as BillingService;
  return { svc: new AdminTenantsService(db, billing, audit), audits, billing };
}

describe('AdminTenantsService', () => {
  it('list 返回租户计费摘要', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0]).toMatchObject({
      id: 't1', planId: 'pro', balance: 900, reserved: 100, userCount: 2,
    });
  });

  it('detail 复用 BillingService.summary 并记 tenant.view', async () => {
    const { svc, audits, billing } = makeService();
    const detail = await svc.detail('t1', actor);
    expect(billing.summary).toHaveBeenCalledWith('t1');
    expect(detail).toMatchObject({ sessionCount: 4, billing: summary });
    expect(audits[0]).toMatchObject({ action: 'tenant.view', targetId: 't1' });
  });

  it('subscribe 作用于路径租户并在同一事务写审计', async () => {
    const { svc, audits, billing } = makeService();
    const out = await svc.subscribe('t1', { planId: 'pro' }, actor);
    expect(out).toEqual(summary);
    expect(billing.adminSubscribe).toHaveBeenCalledWith('t1', 'pro', expect.any(Date), expect.any(Function));
    expect(audits[0]).toMatchObject({ action: 'member.subscribe', targetId: 't1' });
  });

  it('credits 校验金额并写审计', async () => {
    const { svc, audits } = makeService();
    await svc.credits('t1', { amount: 100, note: '补偿' }, actor);
    expect(audits[0]).toMatchObject({ action: 'member.credits', targetId: 't1' });
    await expect(svc.credits('t1', { amount: 0 }, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.credits('t1', { amount: 1.5 }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('租户不存在抛 404', async () => {
    const { svc } = makeService(false);
    await expect(svc.detail('t1', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-tenants`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 给 BillingService 增加可选写事务钩子**

在 `apps/bff/src/billing/billing.service.ts` 增加类型：

```ts
/** 管理操作写入后的同事务回调（审计用）；不传则行为不变。 */
export type BillingWriteHook = (tx: Prisma.TransactionClient) => Promise<void>;
```

改 `adminSubscribe` 签名与事务尾部：

```ts
  async adminSubscribe(
    tenantId: string,
    planId: string,
    now = new Date(),
    afterWrite?: BillingWriteHook,
  ): Promise<BillingSummaryDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.active) throw new NotFoundException('plan_not_found');
    if (plan.id === 'free') throw new BadRequestException('free_not_subscribable');

    const start = now;
    const end = addMonth(now);
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.upsert({
        where: { tenantId },
        create: { tenantId, planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
        update: { planId: plan.id, status: 'active', periodStart: start, periodEnd: end },
      });
      await this.grantPeriod(tx, tenantId, plan, start, end);
      await afterWrite?.(tx);
    });
    return this.summary(tenantId);
  }
```

改 `adjust` 签名与事务尾部（在 `return` 前补 `await afterWrite?.(tx);`，正负两支都要）：

```ts
  async adjust(
    tenantId: string,
    amount: number,
    note: string,
    expiresAt: Date | null,
    afterWrite?: BillingWriteHook,
  ): Promise<BillingSummaryDto> {
    if (amount === 0) throw new BadRequestException('amount_required');
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantCredit.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
      await this.lockCredit(tx, tenantId);

      if (amount > 0) {
        const current = await tx.tenantCredit.findUnique({ where: { tenantId } });
        if ((current?.balance ?? 0) + amount > 2_147_483_647) {
          throw new BadRequestException('amount_too_large');
        }
        await tx.creditLot.create({
          data: { tenantId, source: 'adjust', granted: amount, remaining: amount, expiresAt, note },
        });
        await tx.creditTx.create({
          data: { tenantId, type: 'adjust', amount, source: 'adjust', note },
        });
        await tx.tenantCredit.update({
          where: { tenantId },
          data: { balance: { increment: amount } },
        });
        await afterWrite?.(tx);
        return;
      }

      const target = -amount;
      const credit = await tx.tenantCredit.findUnique({ where: { tenantId } });
      if ((credit?.balance ?? 0) - (credit?.reserved ?? 0) < target) {
        throw new BadRequestException('insufficient_balance');
      }
      const lots = await tx.creditLot.findMany({
        where: { tenantId, remaining: { gt: 0 } },
      });
      const { allocations, deducted } = allocate(lots, target);
      if (deducted < target) throw new BadRequestException('insufficient_balance');
      for (const a of allocations) {
        await tx.creditLot.update({
          where: { id: a.lotId },
          data: { remaining: { decrement: a.amount } },
        });
      }
      await tx.creditTx.create({
        data: { tenantId, type: 'adjust', amount: -deducted, source: 'adjust', note },
      });
      await tx.tenantCredit.update({
        where: { tenantId },
        data: { balance: { decrement: deducted } },
      });
      await afterWrite?.(tx);
    });
    return this.summary(tenantId);
  }
```

- [ ] **Step 4: 实现租户服务与控制器**

`apps/bff/src/admin/admin-tenants.service.ts`：

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminCreditsRequest,
  AdminSubscribeRequest,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  BillingSummaryDto,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { BillingService } from '../billing/billing.service';
import { optionalString, parsePage } from './admin.util';

const MAX_ADJUST_AMOUNT = 1_000_000_000;

interface TenantRow {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
  subscription: { planId: string; status: string; plan: { name: string } } | null;
  credit: { balance: number; reserved: number } | null;
  _count: { users: number };
}

function toItem(row: TenantRow): AdminTenantItemDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    planId: row.subscription?.planId ?? 'free',
    planName: row.subscription?.plan.name ?? '—',
    subscriptionStatus: row.subscription?.status ?? 'none',
    balance: Math.max(0, (row.credit?.balance ?? 0) - (row.credit?.reserved ?? 0)),
    reserved: row.credit?.reserved ?? 0,
    userCount: row._count.users,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminTenantItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const q = optionalString(query.q);
    const planId = optionalString(query.planId);

    const where: Prisma.TenantWhereInput = {
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };

    // Subscription 与 Tenant 不是 Prisma 关系，先取租户 id 集合再做 in 过滤，保证 total 准确。
    if (planId) {
      const subs = await this.prisma.subscription.findMany({
        where: { planId },
        select: { tenantId: true },
      });
      where.id = { in: subs.map((s) => s.tenantId) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        include: {
          subscription: { include: { plan: { select: { name: true } } } },
          credit: true,
          _count: { select: { users: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return { items: rows.map((r) => toItem(r as TenantRow)), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminTenantDetailDto> {
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: { include: { plan: { select: { name: true } } } },
        credit: true,
        _count: { select: { users: true } },
      },
    });
    if (!row) throw new NotFoundException('tenant_not_found');

    const [billing, sessionCount] = await Promise.all([
      this.billing.summary(id),
      this.prisma.session.count({ where: { tenantId: id } }),
    ]);

    await this.audit.bestEffort(actor, {
      action: 'tenant.view',
      targetType: 'tenant',
      targetId: id,
    });

    return { ...toItem(row as TenantRow), sessionCount, billing };
  }

  async subscribe(
    id: string,
    body: AdminSubscribeRequest,
    actor: AdminActor,
  ): Promise<BillingSummaryDto> {
    if (typeof body?.planId !== 'string' || body.planId === '') {
      throw new BadRequestException('invalid_plan');
    }
    await this.assertTenant(id);
    return this.billing.adminSubscribe(id, body.planId, new Date(), (tx) =>
      this.audit.write(tx, actor, {
        action: 'member.subscribe',
        targetType: 'tenant',
        targetId: id,
        summary: { planId: body.planId },
      }),
    );
  }

  async credits(
    id: string,
    body: AdminCreditsRequest,
    actor: AdminActor,
  ): Promise<BillingSummaryDto> {
    const amount = body?.amount;
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount === 0 ||
      Math.abs(amount) > MAX_ADJUST_AMOUNT
    ) {
      throw new BadRequestException('invalid_amount');
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'string') throw new BadRequestException('invalid_expires_at');
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('invalid_expires_at');
    }
    const note = typeof body.note === 'string' ? body.note : '';
    await this.assertTenant(id);
    return this.billing.adjust(id, amount, note, expiresAt, (tx) =>
      this.audit.write(tx, actor, {
        action: 'member.credits',
        targetType: 'tenant',
        targetId: id,
        summary: { amount, note, expiresAt: expiresAt?.toISOString() ?? null },
      }),
    );
  }

  private async assertTenant(id: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!tenant) throw new NotFoundException('tenant_not_found');
  }
}
```

`apps/bff/src/admin/admin-tenants.controller.ts`：

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminCreditsRequest,
  AdminSubscribeRequest,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  BillingSummaryDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminTenantsService } from './admin-tenants.service';

@Controller('api/admin/tenants')
@UseGuards(JwtGuard, AdminGuard)
export class AdminTenantsController {
  constructor(private readonly tenants: AdminTenantsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminTenantItemDto>> {
    return this.tenants.list(query ?? {});
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminTenantDetailDto> {
    return this.tenants.detail(id, actorOf(user, req));
  }

  @Post(':id/subscribe')
  @HttpCode(200)
  subscribe(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminSubscribeRequest,
  ): Promise<BillingSummaryDto> {
    return this.tenants.subscribe(id, body, actorOf(user, req));
  }

  @Post(':id/credits')
  @HttpCode(200)
  credits(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminCreditsRequest,
  ): Promise<BillingSummaryDto> {
    return this.tenants.credits(id, body, actorOf(user, req));
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-tenants src/billing`
Expected: 全部 PASS（既有计费测试不受可选参数影响）。

- [ ] **Step 6: 提交**

```bash
git add apps/bff/src/admin/admin-tenants.service.ts apps/bff/src/admin/admin-tenants.controller.ts apps/bff/src/admin/admin-tenants.service.test.ts apps/bff/src/billing/billing.service.ts
git commit -m "feat(bff): 新增管理端会员与租户接口"
```

---

## Task 7: 管理端套餐接口

**Files:**
- Create: `apps/bff/src/admin/admin-plans.service.ts`
- Create: `apps/bff/src/admin/admin-plans.controller.ts`
- Test: `apps/bff/src/admin/admin-plans.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/admin/admin-plans.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminPlansService } from './admin-plans.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

type PlanRow = {
  id: string; name: string; priceCents: number; monthlyBaseCredits: number;
  monthlyBonusCredits: number; maxCreditsPerRun: number; rpm: number;
  allowedModels: string[]; active: boolean; createdAt: Date;
};

function makeService(prices = ['m1']) {
  const plans = new Map<string, PlanRow>();
  plans.set('free', {
    id: 'free', name: '免费版', priceCents: 0, monthlyBaseCredits: 100,
    monthlyBonusCredits: 0, maxCreditsPerRun: 10, rpm: 2,
    allowedModels: ['m1'], active: true, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const audits: unknown[] = [];
  const db = {
    plan: {
      findMany: async () => [...plans.values()],
      findUnique: async ({ where }: { where: { id: string } }) => plans.get(where.id) ?? null,
      create: async ({ data }: { data: PlanRow }) => {
        plans.set(data.id, data);
        return data;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<PlanRow> }) => {
        const next = { ...plans.get(where.id)!, ...data };
        plans.set(where.id, next);
        return next;
      },
    },
    modelPrice: {
      findMany: async ({ where }: { where: { model: { in: string[] } } }) =>
        where.model.in.filter((m) => prices.includes(m)).map((model) => ({ model })),
    },
    adminAuditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminPlansService(db, audit), plans, audits };
}

describe('AdminPlansService', () => {
  it('listAll 返回含停用套餐', async () => {
    const { svc } = makeService();
    await expect(svc.listAll()).resolves.toHaveLength(1);
  });

  it('创建校验 slug 与数值', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ id: 'Bad ID', name: 'x', priceCents: 0, monthlyBaseCredits: 0, monthlyBonusCredits: 0, maxCreditsPerRun: 0, rpm: 0, allowedModels: ['m1'], active: true }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allowedModels 必须都有价格', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ id: 'pro', name: '专业版', priceCents: 1, monthlyBaseCredits: 1, monthlyBonusCredits: 0, maxCreditsPerRun: 1, rpm: 1, allowedModels: ['missing'], active: true }, actor),
    ).rejects.toMatchObject({ message: 'model_price_missing' });
  });

  it('重复 id 抛 409', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ id: 'free', name: 'x', priceCents: 0, monthlyBaseCredits: 0, monthlyBonusCredits: 0, maxCreditsPerRun: 0, rpm: 0, allowedModels: ['m1'], active: true }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('free 不可停用', async () => {
    const { svc } = makeService();
    await expect(svc.update('free', { active: false }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('更新写 plan.update 审计', async () => {
    const { svc, audits } = makeService();
    const out = await svc.update('free', { name: '基础版' }, actor);
    expect(out.name).toBe('基础版');
    expect(audits[0]).toMatchObject({ action: 'plan.update', targetId: 'free' });
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.update('nope', { name: 'x' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-plans`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现服务与控制器**

`apps/bff/src/admin/admin-plans.service.ts`：

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Plan } from '@prisma/client';
import type { AdminPlanDto, AdminPlanInput, AdminPlanPatch } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

const PLAN_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

function toDto(plan: Plan): AdminPlanDto {
  return {
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    monthlyBaseCredits: plan.monthlyBaseCredits,
    monthlyBonusCredits: plan.monthlyBonusCredits,
    maxCreditsPerRun: plan.maxCreditsPerRun,
    rpm: plan.rpm,
    allowedModels: plan.allowedModels,
    active: plan.active,
    createdAt: plan.createdAt.toISOString(),
  };
}

function nonNegativeInt(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new BadRequestException(`invalid_${field}`);
  }
  return raw;
}

function nonEmptyString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException(`invalid_${field}`);
  }
  return raw.trim();
}

function modelList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('invalid_allowedModels');
  const models = raw.map((m) => (typeof m === 'string' ? m.trim() : ''));
  if (models.some((m) => m === '')) throw new BadRequestException('invalid_allowedModels');
  return [...new Set(models)];
}

@Injectable()
export class AdminPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listAll(): Promise<AdminPlanDto[]> {
    const rows = await this.prisma.plan.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toDto);
  }

  async create(body: AdminPlanInput, actor: AdminActor): Promise<AdminPlanDto> {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!PLAN_ID_RE.test(id)) throw new BadRequestException('invalid_plan_id');

    const input: AdminPlanInput = {
      id,
      name: nonEmptyString(body.name, 'name'),
      priceCents: nonNegativeInt(body.priceCents, 'priceCents'),
      monthlyBaseCredits: nonNegativeInt(body.monthlyBaseCredits, 'monthlyBaseCredits'),
      monthlyBonusCredits: nonNegativeInt(body.monthlyBonusCredits, 'monthlyBonusCredits'),
      maxCreditsPerRun: nonNegativeInt(body.maxCreditsPerRun, 'maxCreditsPerRun'),
      rpm: nonNegativeInt(body.rpm, 'rpm'),
      allowedModels: modelList(body.allowedModels),
      active: body.active === undefined ? true : Boolean(body.active),
    };
    await this.assertModelsPriced(input.allowedModels);

    const exists = await this.prisma.plan.findUnique({ where: { id }, select: { id: true } });
    if (exists) throw new ConflictException('plan_exists');

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.plan.create({ data: input });
      await this.audit.write(tx, actor, {
        action: 'plan.create',
        targetType: 'plan',
        targetId: id,
        summary: { name: input.name },
      });
      return created;
    });
    return toDto(row);
  }

  async update(id: string, body: AdminPlanPatch, actor: AdminActor): Promise<AdminPlanDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('plan_not_found');

    const patch: Partial<AdminPlanInput> = {};
    if (body?.name !== undefined) patch.name = nonEmptyString(body.name, 'name');
    const intFields = [
      'priceCents',
      'monthlyBaseCredits',
      'monthlyBonusCredits',
      'maxCreditsPerRun',
      'rpm',
    ] as const;
    for (const field of intFields) {
      if (body?.[field] !== undefined) patch[field] = nonNegativeInt(body[field], field);
    }
    if (body?.allowedModels !== undefined) patch.allowedModels = modelList(body.allowedModels);
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new BadRequestException('invalid_active');
      patch.active = body.active;
    }
    if (Object.keys(patch).length === 0) throw new BadRequestException('invalid_patch');

    if (id === 'free' && patch.active === false) {
      throw new BadRequestException('free_not_deactivatable');
    }
    if (patch.allowedModels) await this.assertModelsPriced(patch.allowedModels);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.plan.update({ where: { id }, data: patch });
      await this.audit.write(tx, actor, {
        action: 'plan.update',
        targetType: 'plan',
        targetId: id,
        summary: { before: toDto(plan), after: toDto(updated) },
      });
      return updated;
    });
    return toDto(row);
  }

  private async assertModelsPriced(models: string[]): Promise<void> {
    const found = await this.prisma.modelPrice.findMany({
      where: { model: { in: models } },
      select: { model: true },
    });
    if (found.length !== models.length) throw new BadRequestException('model_price_missing');
  }
}
```

`apps/bff/src/admin/admin-plans.controller.ts`：

```ts
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminPlanDto, AdminPlanInput, AdminPlanPatch } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminPlansService } from './admin-plans.service';

@Controller('api/admin/plans')
@UseGuards(JwtGuard, AdminGuard)
export class AdminPlansController {
  constructor(private readonly plans: AdminPlansService) {}

  @Get()
  list(): Promise<AdminPlanDto[]> {
    return this.plans.listAll();
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: AdminPlanInput,
  ): Promise<AdminPlanDto> {
    return this.plans.create(body, actorOf(user, req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AdminPlanPatch,
  ): Promise<AdminPlanDto> {
    return this.plans.update(id, body ?? {}, actorOf(user, req));
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-plans`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/admin/admin-plans.service.ts apps/bff/src/admin/admin-plans.controller.ts apps/bff/src/admin/admin-plans.service.test.ts
git commit -m "feat(bff): 新增管理端套餐接口"
```

---

## Task 8: 管理端会话接口与归档语义

**Files:**
- Modify: `apps/bff/src/sessions/sessions.service.ts`
- Create: `apps/bff/src/admin/admin-sessions.service.ts`
- Create: `apps/bff/src/admin/admin-sessions.controller.ts`
- Test: `apps/bff/src/sessions/sessions.service.test.ts`
- Test: `apps/bff/src/admin/admin-sessions.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/sessions/sessions.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import type { PrismaService } from '../db/prisma.service';

const all = [
  { id: 's1', tenantId: 't1', userId: 'u1', title: 'active', status: 'active', createdAt: new Date() },
  { id: 's2', tenantId: 't1', userId: 'u1', title: 'archived', status: 'archived', createdAt: new Date() },
];

function makeService() {
  const prisma = {
    session: {
      findMany: async ({ where }: { where: { tenantId: string; userId: string; status?: { not: string } } }) =>
        all.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            (!where.status?.not || s.status !== where.status.not),
        ),
      findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string; status?: { not: string } } }) =>
        all.find(
          (s) =>
            s.id === where.id &&
            s.tenantId === where.tenantId &&
            s.userId === where.userId &&
            (!where.status?.not || s.status !== where.status.not),
        ) ?? null,
    },
  } as unknown as PrismaService;
  return new SessionsService(prisma);
}

describe('SessionsService 归档语义', () => {
  it('list 不返回归档会话', async () => {
    const list = await makeService().list('t1', 'u1');
    expect(list.map((s) => s.id)).toEqual(['s1']);
  });

  it('归档会话对普通用户视为不存在', async () => {
    await expect(makeService().assertOwned('s2', 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

`apps/bff/src/admin/admin-sessions.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AdminSessionsService } from './admin-sessions.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

function makeService(seedArchived = false) {
  const session = {
    id: 's1', title: '季度汇报', status: seedArchived ? 'archived' : 'active',
    tenantId: 't1', userId: 'u1', createdAt: new Date('2026-10-01T00:00:00Z'),
    user: { email: 'u1@test.local' },
    _count: { messages: 4, tasks: 2 },
  };
  const audits: unknown[] = [];
  const db = {
    session: {
      findMany: async () => [session],
      count: async () => 1,
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 's1' ? session : null),
      update: async ({ data }: { data: { status: string } }) => {
        session.status = data.status;
        return session;
      },
    },
    message: {
      findMany: async () => [
        { id: 'm1', role: 'user', content: 'hi', seq: 0, createdAt: new Date('2026-10-01T00:00:00Z') },
      ],
    },
    task: { count: async () => 2 },
    artifact: { count: async () => 1 },
    adminAuditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminSessionsService(db, audit), audits, session };
}

describe('AdminSessionsService', () => {
  it('list 返回消息/任务计数', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0]).toMatchObject({ messageCount: 4, taskCount: 2, userEmail: 'u1@test.local' });
  });

  it('messages 按 seq 分页并记 messages.view（不含正文）', async () => {
    const { svc, audits } = makeService();
    const page = await svc.messages('s1', { page: '1', pageSize: '20' }, actor);
    expect(page.items[0]).toMatchObject({ seq: 0, content: 'hi' });
    expect(audits[0]).toMatchObject({ action: 'messages.view', targetId: 's1' });
    expect(JSON.stringify(audits[0])).not.toContain('hi');
  });

  it('archive 归档并记 session.archive', async () => {
    const { svc, audits, session } = makeService();
    await svc.archive('s1', actor);
    expect(session.status).toBe('archived');
    expect(audits[0]).toMatchObject({ action: 'session.archive', targetId: 's1' });
  });

  it('会话不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/sessions/sessions.service src/admin/admin-sessions`
Expected: FAIL —— 归档过滤与模块尚未实现。

- [ ] **Step 3: 用户侧会话服务增加归档过滤**

`apps/bff/src/sessions/sessions.service.ts`：

```ts
  async list(tenantId: string, userId: string): Promise<SessionSummary[]> {
    const rows = await this.prisma.session.findMany({
      // 归档会话对普通用户不可见。
      where: { tenantId, userId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt.toISOString() }));
  }

  /** 校验会话归属（tenant 强制行级隔离，上游 §7）：非本租户/用户或已归档一律 404，不泄露存在性。 */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, status: { not: 'archived' } },
    });
    if (!s) throw new NotFoundException('session_not_found');
  }
```

- [ ] **Step 4: 实现管理端会话服务与控制器**

`apps/bff/src/admin/admin-sessions.service.ts`：

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminMessageDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { optionalString, parsePage } from './admin.util';

interface SessionRow {
  id: string;
  title: string;
  status: string;
  tenantId: string;
  createdAt: Date;
  user: { email: string };
  _count: { messages: number; tasks: number };
}

function toItem(row: SessionRow): AdminSessionItemDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    tenantId: row.tenantId,
    userEmail: row.user.email,
    messageCount: row._count.messages,
    taskCount: row._count.tasks,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminSessionItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const tenantId = optionalString(query.tenantId);
    const userId = optionalString(query.userId);
    const q = optionalString(query.q);
    const status = optionalString(query.status);

    const where: Prisma.SessionWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(userId ? { userId } : {}),
      ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      ...(status ? { status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        include: {
          user: { select: { email: true } },
          _count: { select: { messages: true, tasks: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.session.count({ where }),
    ]);

    return { items: rows.map((r) => toItem(r as SessionRow)), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminSessionDetailDto> {
    const row = await this.getSession(id);
    const artifactCount = await this.prisma.artifact.count({ where: { sessionId: id } });
    await this.audit.bestEffort(actor, {
      action: 'session.view',
      targetType: 'session',
      targetId: id,
    });
    return { ...toItem(row), artifactCount };
  }

  async messages(
    id: string,
    query: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<PageDto<AdminMessageDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const exists = await this.prisma.session.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('session_not_found');

    const [rows, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { sessionId: id },
        orderBy: { seq: 'asc' },
        skip,
        take,
      }),
      this.prisma.message.count({ where: { sessionId: id } }),
    ]);

    // 不记录正文：只记会话与分页范围。
    await this.audit.bestEffort(actor, {
      action: 'messages.view',
      targetType: 'session',
      targetId: id,
      summary: { page, pageSize },
    });

    return {
      items: rows.map((m) => ({
        id: m.id,
        role: m.role as AdminMessageDto['role'],
        content: m.content,
        seq: m.seq,
        createdAt: m.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async archive(id: string, actor: AdminActor): Promise<AdminSessionItemDto> {
    const row = await this.getSession(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { id }, data: { status: 'archived' } });
      await this.audit.write(tx, actor, {
        action: 'session.archive',
        targetType: 'session',
        targetId: id,
        summary: { before: row.status, after: 'archived' },
      });
    });
    return { ...toItem(row), status: 'archived' };
  }

  private async getSession(id: string): Promise<SessionRow> {
    const row = await this.prisma.session.findUnique({
      where: { id },
      include: {
        user: { select: { email: true } },
        _count: { select: { messages: true, tasks: true } },
      },
    });
    if (!row) throw new NotFoundException('session_not_found');
    return row as SessionRow;
  }
}
```

`apps/bff/src/admin/admin-sessions.controller.ts`：

```ts
import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  AdminMessageDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  PageDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminSessionsService } from './admin-sessions.service';
import { BadRequestException } from '@nestjs/common';

@Controller('api/admin/sessions')
@UseGuards(JwtGuard, AdminGuard)
export class AdminSessionsController {
  constructor(private readonly sessions: AdminSessionsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminSessionItemDto>> {
    return this.sessions.list(query ?? {});
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminSessionDetailDto> {
    return this.sessions.detail(id, actorOf(user, req));
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PageDto<AdminMessageDto>> {
    return this.sessions.messages(id, query ?? {}, actorOf(user, req));
  }

  @Patch(':id')
  archive(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { status?: unknown },
  ): Promise<AdminSessionItemDto> {
    if (body?.status !== 'archived') throw new BadRequestException('invalid_status');
    return this.sessions.archive(id, actorOf(user, req));
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/sessions src/admin/admin-sessions`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/bff/src/sessions/sessions.service.ts apps/bff/src/sessions/sessions.service.test.ts apps/bff/src/admin/admin-sessions.service.ts apps/bff/src/admin/admin-sessions.controller.ts apps/bff/src/admin/admin-sessions.service.test.ts
git commit -m "feat(bff): 新增管理端会话接口并支持归档语义"
```

---

## Task 9: 管理端任务与运行接口

**Files:**
- Create: `apps/bff/src/admin/admin-tasks.service.ts`
- Create: `apps/bff/src/admin/admin-tasks.controller.ts`
- Test: `apps/bff/src/admin/admin-tasks.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/admin/admin-tasks.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AdminTasksService } from './admin-tasks.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

function makeService() {
  const task = {
    id: 'task1',
    sessionId: 's1',
    goal: 'x'.repeat(300),
    status: 'done',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    runs: [{ status: 'done' }],
  };
  const run = {
    id: 'r1',
    taskId: 'task1',
    status: 'done',
    startedAt: new Date('2026-10-01T00:00:00Z'),
    endedAt: new Date('2026-10-01T00:01:00Z'),
    steps: [
      { id: 'st1', seq: 0, type: 'think', payload: { text: 'hi' }, ts: new Date('2026-10-01T00:00:01Z') },
    ],
    _count: { steps: 1 },
  };
  const audits: unknown[] = [];
  const db = {
    task: {
      findMany: async () => [task],
      count: async () => 1,
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'task1' ? task : null),
    },
    run: {
      findMany: async () => [run],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'r1' ? run : null),
    },
    usageRecord: {
      findMany: async () => [{ runId: 'r1', credits: 7 }],
      findUnique: async ({ where }: { where: { runId: string } }) =>
        where.runId === 'r1'
          ? { inputTokens: 10, outputTokens: 20, credits: 7, status: 'settled', models: [] }
          : null,
    },
    adminAuditLog: { create: async () => ({}) },
  } as unknown as PrismaService;
  const audit = {
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminTasksService(db, audit), audits };
}

describe('AdminTasksService', () => {
  it('list 目标截断 200 字并带最近运行状态', async () => {
    const { svc } = makeService();
    const page = await svc.list({ page: '1', pageSize: '20' });
    expect(page.items[0].goal).toHaveLength(200);
    expect(page.items[0].latestRunStatus).toBe('done');
  });

  it('detail 返回运行与积分', async () => {
    const { svc, audits } = makeService();
    const detail = await svc.detail('task1', actor);
    expect(detail.runs[0]).toMatchObject({ id: 'r1', credits: 7 });
    expect(audits[0]).toMatchObject({ action: 'task.view', targetId: 'task1' });
  });

  it('runDetail 返回分页 step 与用量', async () => {
    const { svc, audits } = makeService();
    const detail = await svc.runDetail('r1', { stepPage: '1', stepPageSize: '20' }, actor);
    expect(detail.steps.items[0]).toMatchObject({ seq: 0, type: 'think' });
    expect(detail.usage).toMatchObject({ credits: 7, status: 'settled' });
    expect(audits[0]).toMatchObject({ action: 'run.view', targetId: 'r1' });
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.detail('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-tasks`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现服务与控制器**

`apps/bff/src/admin/admin-tasks.service.ts`：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminRunDetailDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { optionalString, parsePage } from './admin.util';

const GOAL_PREVIEW_LIMIT = 200;

interface TaskRow {
  id: string;
  sessionId: string;
  goal: string;
  status: string;
  createdAt: Date;
  runs: { status: string }[];
}

function toItem(row: TaskRow): AdminTaskItemDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    goal:
      row.goal.length > GOAL_PREVIEW_LIMIT
        ? `${row.goal.slice(0, GOAL_PREVIEW_LIMIT)}…`
        : row.goal,
    status: row.status,
    latestRunStatus: row.runs[0]?.status ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminTaskItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const tenantId = optionalString(query.tenantId);
    const sessionId = optionalString(query.sessionId);
    const userId = optionalString(query.userId);
    const status = optionalString(query.status);

    const sessionFilter: Prisma.SessionWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(userId ? { userId } : {}),
    };

    const where: Prisma.TaskWhereInput = {
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
      ...(tenantId || userId ? { session: { is: sessionFilter } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { status: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.task.count({ where }),
    ]);

    return { items: rows.map((r) => toItem(r as TaskRow)), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminTaskDetailDto> {
    const row = await this.prisma.task.findUnique({
      where: { id },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { status: true } } },
    });
    if (!row) throw new NotFoundException('task_not_found');

    const runs = await this.prisma.run.findMany({
      where: { taskId: id },
      orderBy: { startedAt: 'desc' },
    });
    const usages = await this.prisma.usageRecord.findMany({
      where: { runId: { in: runs.map((r) => r.id) } },
      select: { runId: true, credits: true },
    });
    const creditsByRun = new Map(usages.map((u) => [u.runId, u.credits]));

    await this.audit.bestEffort(actor, {
      action: 'task.view',
      targetType: 'task',
      targetId: id,
    });

    return {
      ...toItem(row as TaskRow),
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        credits: creditsByRun.get(r.id) ?? null,
      })),
    };
  }

  async runDetail(
    id: string,
    query: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminRunDetailDto> {
    const { page, pageSize, skip, take } = parsePage(query.stepPage, query.stepPageSize);
    const run = await this.prisma.run.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { seq: 'asc' }, skip, take },
        _count: { select: { steps: true } },
      },
    });
    if (!run) throw new NotFoundException('run_not_found');

    const usage = await this.prisma.usageRecord.findUnique({ where: { runId: id } });

    await this.audit.bestEffort(actor, {
      action: 'run.view',
      targetType: 'run',
      targetId: id,
    });

    return {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      steps: {
        items: run.steps.map((s) => ({
          id: s.id,
          seq: s.seq,
          type: s.type,
          payload: (s.payload ?? {}) as Record<string, unknown>,
          ts: s.ts.toISOString(),
        })),
        total: run._count.steps,
        page,
        pageSize,
      },
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            credits: usage.credits,
            status: usage.status,
            models: usage.models,
          }
        : null,
    };
  }
}
```

`apps/bff/src/admin/admin-tasks.controller.ts`：

```ts
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminRunDetailDto, AdminTaskDetailDto, AdminTaskItemDto, PageDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminTasksService } from './admin-tasks.service';

@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminTasksController {
  constructor(private readonly tasks: AdminTasksService) {}

  @Get('tasks')
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminTaskItemDto>> {
    return this.tasks.list(query ?? {});
  }

  @Get('tasks/:id')
  detail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<AdminTaskDetailDto> {
    return this.tasks.detail(id, actorOf(user, req));
  }

  @Get('runs/:id')
  runDetail(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminRunDetailDto> {
    return this.tasks.runDetail(id, query ?? {}, actorOf(user, req));
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-tasks`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/admin/admin-tasks.service.ts apps/bff/src/admin/admin-tasks.controller.ts apps/bff/src/admin/admin-tasks.service.test.ts
git commit -m "feat(bff): 新增管理端任务与运行只读接口"
```

---

## Task 10: 管理端模型价格接口

**Files:**
- Create: `apps/bff/src/admin/admin-models.service.ts`
- Create: `apps/bff/src/admin/admin-models.controller.ts`
- Test: `apps/bff/src/admin/admin-models.service.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/admin/admin-models.service.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminModelsService, listProviders } from './admin-models.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../db/prisma.service';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

function makeService(inUse = false) {
  const prices = new Map([
    ['m1', { model: 'm1', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 200, updatedAt: new Date('2026-10-01T00:00:00Z') }],
  ]);
  const audits: unknown[] = [];
  const db = {
    modelPrice: {
      findMany: async () => [...prices.values()],
      findUnique: async ({ where }: { where: { model: string } }) => prices.get(where.model) ?? null,
      create: async ({ data }: { data: { model: string; inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number } }) => {
        const row = { ...data, updatedAt: new Date('2026-10-19T00:00:00Z') };
        prices.set(data.model, row);
        return row;
      },
      update: async ({ where, data }: { where: { model: string }; data: Record<string, number> }) => {
        const row = { ...prices.get(where.model)!, ...data, updatedAt: new Date('2026-10-19T00:00:00Z') };
        prices.set(where.model, row);
        return row;
      },
      delete: async ({ where }: { where: { model: string } }) => {
        prices.delete(where.model);
        return {};
      },
    },
    plan: {
      findFirst: async () => (inUse ? { id: 'pro' } : null),
    },
    adminAuditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as PrismaService;
  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { svc: new AdminModelsService(db, audit), audits };
}

describe('AdminModelsService', () => {
  it('catalog 不返回任何密钥信息', () => {
    const providers = listProviders({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'http://x', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'http://x', apiKeyEnv: 'KEY_A' },
      ]),
    });
    expect(providers).toEqual([{ name: 'KEY_A', models: ['a', 'b'] }]);
    expect(JSON.stringify(providers)).not.toContain('http://x');
  });

  it('创建/更新/删除写审计', async () => {
    const { svc, audits } = makeService();
    await svc.create({ model: 'm2', inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 2 }, actor);
    await svc.update('m2', { inputMilliCreditsPer1k: 3 }, actor);
    await svc.remove('m2', actor);
    expect(audits.map((a) => (a as { action: string }).action)).toEqual([
      'modelPrice.create',
      'modelPrice.update',
      'modelPrice.delete',
    ]);
  });

  it('重复模型抛 409', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ model: 'm1', inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('负价格抛 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({ model: 'm2', inputMilliCreditsPer1k: -1, outputMilliCreditsPer1k: 1 }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('被启用套餐引用时拒绝删除', async () => {
    const { svc } = makeService(true);
    await expect(svc.remove('m1', actor)).rejects.toMatchObject({ message: 'model_in_use' });
  });

  it('不存在抛 404', async () => {
    const { svc } = makeService();
    await expect(svc.update('missing', { rpm: 1 } as never, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-models`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现服务与控制器**

`apps/bff/src/admin/admin-models.service.ts`：

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminModelPriceDto,
  AdminModelProviderDto,
  AdminModelsDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';

/** 从运行时同款环境变量解析 provider/模型清单；只暴露名字，绝不读取密钥值。 */
export function listProviders(env: NodeJS.ProcessEnv): AdminModelProviderDto[] {
  if (env.MODEL_PROVIDERS) {
    try {
      const parsed: unknown = JSON.parse(env.MODEL_PROVIDERS);
      if (Array.isArray(parsed)) {
        const groups = new Map<string, string[]>();
        for (const item of parsed) {
          if (item === null || typeof item !== 'object') continue;
          const p = item as Record<string, unknown>;
          if (typeof p.model !== 'string' || p.model === '') continue;
          const name = typeof p.apiKeyEnv === 'string' && p.apiKeyEnv !== '' ? p.apiKeyEnv : 'default';
          groups.set(name, [...(groups.get(name) ?? []), p.model]);
        }
        if (groups.size > 0) return [...groups].map(([name, models]) => ({ name, models }));
      }
    } catch {
      // 配置非法时管理端仍应可用，回落单模型视图。
    }
  }
  return [{ name: 'default', models: [env.MODEL_NAME ?? 'deepseek-chat'] }];
}

function priceInt(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new BadRequestException('invalid_price');
  }
  return raw;
}

function modelName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new BadRequestException('invalid_model');
  return raw.trim();
}

function toDto(row: {
  model: string;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  updatedAt: Date;
}): AdminModelPriceDto {
  return {
    model: row.model,
    inputMilliCreditsPer1k: row.inputMilliCreditsPer1k,
    outputMilliCreditsPer1k: row.outputMilliCreditsPer1k,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class AdminModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async catalog(): Promise<AdminModelsDto> {
    const rows = await this.prisma.modelPrice.findMany({ orderBy: { model: 'asc' } });
    return { providers: listProviders(process.env), prices: rows.map(toDto) };
  }

  async create(
    body: { model?: unknown; inputMilliCreditsPer1k?: unknown; outputMilliCreditsPer1k?: unknown },
    actor: AdminActor,
  ): Promise<AdminModelPriceDto> {
    const model = modelName(body?.model);
    const input = priceInt(body.inputMilliCreditsPer1k);
    const output = priceInt(body.outputMilliCreditsPer1k);

    const exists = await this.prisma.modelPrice.findUnique({ where: { model }, select: { model: true } });
    if (exists) throw new ConflictException('model_exists');

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.modelPrice.create({
        data: { model, inputMilliCreditsPer1k: input, outputMilliCreditsPer1k: output },
      });
      await this.audit.write(tx, actor, {
        action: 'modelPrice.create',
        targetType: 'modelPrice',
        targetId: model,
        summary: { input, output },
      });
      return created;
    });
    return toDto(row);
  }

  async update(
    model: string,
    body: { inputMilliCreditsPer1k?: unknown; outputMilliCreditsPer1k?: unknown },
    actor: AdminActor,
  ): Promise<AdminModelPriceDto> {
    const before = await this.prisma.modelPrice.findUnique({ where: { model } });
    if (!before) throw new NotFoundException('model_price_not_found');

    const data: { inputMilliCreditsPer1k?: number; outputMilliCreditsPer1k?: number } = {};
    if (body?.inputMilliCreditsPer1k !== undefined) {
      data.inputMilliCreditsPer1k = priceInt(body.inputMilliCreditsPer1k);
    }
    if (body?.outputMilliCreditsPer1k !== undefined) {
      data.outputMilliCreditsPer1k = priceInt(body.outputMilliCreditsPer1k);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('invalid_patch');

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.modelPrice.update({ where: { model }, data });
      await this.audit.write(tx, actor, {
        action: 'modelPrice.update',
        targetType: 'modelPrice',
        targetId: model,
        summary: { before: toDto(before), after: toDto(updated) },
      });
      return updated;
    });
    return toDto(row);
  }

  async remove(model: string, actor: AdminActor): Promise<void> {
    const exists = await this.prisma.modelPrice.findUnique({ where: { model }, select: { model: true } });
    if (!exists) throw new NotFoundException('model_price_not_found');

    const used = await this.prisma.plan.findFirst({
      where: { active: true, allowedModels: { has: model } },
      select: { id: true },
    });
    if (used) throw new BadRequestException('model_in_use');

    await this.prisma.$transaction(async (tx) => {
      await tx.modelPrice.delete({ where: { model } });
      await this.audit.write(tx, actor, {
        action: 'modelPrice.delete',
        targetType: 'modelPrice',
        targetId: model,
      });
    });
  }
}
```

`apps/bff/src/admin/admin-models.controller.ts`：

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminModelPriceDto, AdminModelsDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminModelsService } from './admin-models.service';

@Controller('api/admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminModelsController {
  constructor(private readonly models: AdminModelsService) {}

  @Get('models')
  catalog(): Promise<AdminModelsDto> {
    return this.models.catalog();
  }

  @Post('model-prices')
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelPriceDto> {
    return this.models.create(body ?? {}, actorOf(user, req));
  }

  @Patch('model-prices/:model')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminModelPriceDto> {
    return this.models.update(model, body ?? {}, actorOf(user, req));
  }

  @Delete('model-prices/:model')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('model') model: string,
  ): Promise<void> {
    await this.models.remove(model, actorOf(user, req));
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin-models`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/bff/src/admin/admin-models.service.ts apps/bff/src/admin/admin-models.controller.ts apps/bff/src/admin/admin-models.service.test.ts
git commit -m "feat(bff): 新增管理端模型价格接口"
```

---

## Task 11: 管理端参数/审计接口与模块装配

**Files:**
- Create: `apps/bff/src/admin/admin-settings.controller.ts`
- Create: `apps/bff/src/admin/admin-audit.controller.ts`
- Create: `apps/bff/src/admin/admin.module.ts`
- Modify: `apps/bff/src/app.module.ts`
- Test: `apps/bff/src/admin/admin.endpoints.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/bff/src/admin/admin.endpoints.test.ts`：

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminAuditController } from './admin-audit.controller';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'admin' ? 'admin' : 'member',
      tenantId: 't1',
      email: `${where.id}@test.local`,
    }),
  },
  adminAuditLog: {
    findMany: async () => [],
    count: async () => 0,
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminAuditController],
    providers: [AuditService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('管理端鉴权', () => {
  it('普通成员访问 /api/admin/audit 返回 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('管理员访问返回分页结构', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('禁用管理员返回 401', async () => {
    const prisma = fakePrisma as unknown as { user: { findUnique: () => Promise<unknown> } };
    const original = prisma.user.findUnique;
    prisma.user.findUnique = async () => ({
      status: 'disabled',
      role: 'admin',
      tenantId: 't1',
      email: 'admin@test.local',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` },
    });
    prisma.user.findUnique = original;
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin.endpoints`
Expected: FAIL —— 控制器不存在。

- [ ] **Step 3: 实现参数与审计控制器**

`apps/bff/src/admin/admin-settings.controller.ts`：

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminSettingDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { SettingsService } from '../settings/settings.service';

@Controller('api/admin/settings')
@UseGuards(JwtGuard, AdminGuard)
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list(): Promise<AdminSettingDto[]> {
    return this.settings.getAll();
  }

  @Put(':key')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('key') key: string,
    @Body() body: { value?: unknown },
  ): Promise<AdminSettingDto> {
    if (!body || body.value === undefined) throw new BadRequestException('invalid_value');
    return this.settings.update(key, body.value, actorOf(user, req));
  }

  @Delete(':key')
  @HttpCode(204)
  async reset(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('key') key: string,
  ): Promise<void> {
    await this.settings.reset(key, actorOf(user, req));
  }
}
```

`apps/bff/src/admin/admin-audit.controller.ts`：

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminAuditItemDto, PageDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AuditService } from '../audit/audit.service';

@Controller('api/admin/audit')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminAuditItemDto>> {
    return this.audit.list(query ?? {});
  }
}
```

- [ ] **Step 4: 装配 AdminModule 与 AppModule**

`apps/bff/src/admin/admin.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BillingModule } from '../billing/billing.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPlansService } from './admin-plans.service';
import { AdminSessionsController } from './admin-sessions.controller';
import { AdminSessionsService } from './admin-sessions.service';
import { AdminTasksController } from './admin-tasks.controller';
import { AdminTasksService } from './admin-tasks.service';
import { AdminModelsController } from './admin-models.controller';
import { AdminModelsService } from './admin-models.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminAuditController } from './admin-audit.controller';

@Module({
  imports: [AuditModule, SettingsModule, BillingModule],
  controllers: [
    AdminUsersController,
    AdminTenantsController,
    AdminPlansController,
    AdminSessionsController,
    AdminTasksController,
    AdminModelsController,
    AdminSettingsController,
    AdminAuditController,
  ],
  providers: [
    AdminUsersService,
    AdminTenantsService,
    AdminPlansService,
    AdminSessionsService,
    AdminTasksService,
    AdminModelsService,
  ],
})
export class AdminModule {}
```

`apps/bff/src/app.module.ts` 整体替换为：

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './db/prisma.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { RunsController } from './runs/runs.controller';
import { ArtifactController } from './artifacts/artifacts.controller';
import { ArtifactService } from './artifacts/artifacts.service';
import { ARTIFACT_STORAGE, createArtifactStorage } from './artifacts/storage';
import { KbModule } from './kb/kb.module';
import { ConnectorModule } from './connector/connector.module';
import { BillingModule } from './billing/billing.module';
import { AdminModule } from './admin/admin.module';
import { SettingsModule } from './settings/settings.module';

/** 应用装配根：数据库、知识库、连接器、计费、管理端模块在此汇合。 */
@Module({
  imports: [PrismaModule, BillingModule, KbModule, ConnectorModule, SettingsModule, AdminModule],
  controllers: [AuthController, SessionsController, TasksController, RunsController, ArtifactController],
  providers: [
    AuthService,
    SessionsService,
    TasksService,
    ArtifactService,
    { provide: ARTIFACT_STORAGE, useFactory: () => createArtifactStorage() },
  ],
})
export class AppModule {}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @ai-office/bff test -- src/admin/admin.endpoints`
Expected: PASS。

Run: `pnpm --filter @ai-office/bff typecheck`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add apps/bff/src/admin/admin-settings.controller.ts apps/bff/src/admin/admin-audit.controller.ts apps/bff/src/admin/admin.module.ts apps/bff/src/admin/admin.endpoints.test.ts apps/bff/src/app.module.ts
git commit -m "feat(bff): 装配管理端参数与审计接口"
```

---

## Task 12: 运行参数下发（BFF → runtime）

**Files:**
- Modify: `apps/bff/src/tasks/tasks.controller.ts`
- Create: `apps/agent-runtime/src/run-config.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Modify: `apps/agent-runtime/src/agent-loop.ts`
- Modify: `apps/agent-runtime/src/tools/types.ts`
- Modify: `apps/agent-runtime/src/tools/code-exec.ts`
- Test: `apps/agent-runtime/src/run-config.test.ts`
- Test: `apps/agent-runtime/src/tools/code-exec.test.ts`
- Test: `apps/bff/src/tasks/tasks.controller.test.ts`

- [ ] **Step 1: 先写 runtime 失败测试**

`apps/agent-runtime/src/run-config.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { resolveRunConfig } from './run-config';

describe('resolveRunConfig', () => {
  it('请求值优先于 env', () => {
    const out = resolveRunConfig(
      { maxRounds: 3, confirmTimeoutMs: 2000, codeExecTimeoutMs: 500 },
      { MAX_ROUNDS: '10', CONFIRM_TIMEOUT_MS: '9000', CODE_EXEC_TIMEOUT_MS: '3000' },
    );
    expect(out).toEqual({ maxRounds: 3, confirmTimeoutMs: 2000, codeExecTimeoutMs: 500 });
  });

  it('越界/非整数请求值回落到 env', () => {
    const out = resolveRunConfig(
      { maxRounds: 99, confirmTimeoutMs: 1.5, codeExecTimeoutMs: 'x' as never },
      { MAX_ROUNDS: '10', CONFIRM_TIMEOUT_MS: '9000', CODE_EXEC_TIMEOUT_MS: '3000' },
    );
    expect(out).toEqual({ maxRounds: 10, confirmTimeoutMs: 9000, codeExecTimeoutMs: 3000 });
  });

  it('env 也非法时回落到默认值', () => {
    const out = resolveRunConfig(undefined, {});
    expect(out).toEqual({ maxRounds: 8, confirmTimeoutMs: 120000, codeExecTimeoutMs: 5000 });
  });

  it('请求值为 0 或负数视为非法', () => {
    const out = resolveRunConfig({ maxRounds: 0, confirmTimeoutMs: -1, codeExecTimeoutMs: 0 }, {});
    expect(out).toEqual({ maxRounds: 8, confirmTimeoutMs: 120000, codeExecTimeoutMs: 5000 });
  });
});
```

在 `apps/agent-runtime/src/tools/code-exec.test.ts` 末尾追加（若文件不存在则新建）：

```ts
import { describe, it, expect } from 'vitest';
import { resolveTimeLimit } from './code-exec';

describe('resolveTimeLimit', () => {
  it('调用方只能收紧，不能放宽服务端上限', () => {
    expect(resolveTimeLimit(999999, undefined, 5000)).toBe(5000);
    expect(resolveTimeLimit(1000, undefined, 5000)).toBe(1000);
  });

  it('运行级上限进一步收紧服务端上限', () => {
    expect(resolveTimeLimit(undefined, 2000, 5000)).toBe(2000);
    expect(resolveTimeLimit(4000, 2000, 5000)).toBe(2000);
    expect(resolveTimeLimit(500, 2000, 5000)).toBe(500);
  });

  it('服务端上限硬夹到 60s', () => {
    expect(resolveTimeLimit(undefined, undefined, 120000)).toBe(60000);
    expect(resolveTimeLimit(undefined, 90000, 5000)).toBe(5000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- src/run-config src/tools/code-exec`
Expected: FAIL —— `resolveRunConfig` / `resolveTimeLimit` 不存在。

- [ ] **Step 3: 实现 runtime 参数夹取**

`apps/agent-runtime/src/run-config.ts`：

```ts
import type { RunConfig } from '@ai-office/shared';

export interface ResolvedRunConfig {
  maxRounds: number;
  confirmTimeoutMs: number;
  codeExecTimeoutMs: number;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max
    ? raw
    : fallback;
}

/** runtime 不信任 BFF 下传值：越界、非整数、负数一律回落到 env 或默认值。 */
export function resolveRunConfig(
  config: RunConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedRunConfig {
  return {
    maxRounds: clampInt(config?.maxRounds, 1, 32, clampInt(Number(env.MAX_ROUNDS), 1, 32, 8)),
    confirmTimeoutMs: clampInt(
      config?.confirmTimeoutMs,
      1000,
      600000,
      clampInt(Number(env.CONFIRM_TIMEOUT_MS), 1000, 600000, 120000),
    ),
    codeExecTimeoutMs: clampInt(
      config?.codeExecTimeoutMs,
      100,
      60000,
      clampInt(Number(env.CODE_EXEC_TIMEOUT_MS), 100, 60000, 5000),
    ),
  };
}
```

`apps/agent-runtime/src/tools/types.ts` 的 `RunContext` 增加：

```ts
export interface RunContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  /** 本次运行的代码执行墙钟上限（毫秒）；未设置时用工具自身默认。 */
  codeExecTimeoutMs?: number;
}
```

`apps/agent-runtime/src/agent-loop.ts`：

```ts
export interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;
  onUsage?: (usage: UsageEvent) => void;
  /** 确认闸门：confirm 级工具执行前挂起等待用户决策；未注入时按拒绝处理（fail-safe）。 */
  confirm?: ConfirmGate;
  /** 确认等待上限（毫秒）。 */
  confirmTimeoutMs?: number;
  /** 本次运行的代码执行上限（毫秒），经 RunContext 传给 code.exec。 */
  codeExecTimeoutMs?: number;
  /** 预占额度、允许模型与价格；缺省时不限预算。 */
  billing?: RunBilling;
}
```

```ts
  const ctx: RunContext = {
    tenantId: req.tenantId,
    userId: req.userId,
    sessionId: req.sessionId,
    runId: req.runId,
    codeExecTimeoutMs: deps.codeExecTimeoutMs,
  };
```

`apps/agent-runtime/src/tools/code-exec.ts` 增加纯函数并在 `execute` 使用：

```ts
/** 解析单次执行上限：请求值 ≤ 运行级上限 ≤ 服务端硬上限（60s）。 */
export function resolveTimeLimit(
  requested: unknown,
  ctxLimit: unknown,
  serverLimit: number,
): number {
  const server = Math.min(Math.max(serverLimit, 100), 60000);
  const ctxMax =
    typeof ctxLimit === 'number' && Number.isFinite(ctxLimit) && ctxLimit > 0
      ? Math.min(ctxLimit, server)
      : server;
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, ctxMax)
    : ctxMax;
}
```

```ts
    async execute(args, ctx) {
      const code = String(args.code ?? '');
      // 调用方只能收紧、不能放宽；运行级上限再收紧一次。
      const limit = resolveTimeLimit(args.timeoutMs, ctx.codeExecTimeoutMs, limits.timeoutMs);
      return runSandboxed(spawn, code, { ...limits, timeoutMs: limit });
    },
```

`apps/agent-runtime/src/server.ts`：

- 新增导入：

```ts
import { resolveRunConfig } from './run-config';
```

- 删除模块级 `const confirmTimeoutMs = Number(process.env.CONFIRM_TIMEOUT_MS ?? 120000);`
- 在 `/runs` 处理里、`for await` 前解析：

```ts
            const config = resolveRunConfig(runReq.config, process.env);
            for await (const ev of runAgent(runReq, {
              gateway,
              tools: runTools,
              confirm,
              maxRounds: config.maxRounds,
              confirmTimeoutMs: config.confirmTimeoutMs,
              codeExecTimeoutMs: config.codeExecTimeoutMs,
              billing: runReq.billing,
              onUsage: (u) => res.write(encodeSse({ event: 'usage', data: u })),
            })) {
```

- [ ] **Step 4: BFF 下发 config**

`apps/bff/src/tasks/tasks.controller.ts`：

```ts
import { SettingsService } from '../settings/settings.service';
```

构造器增加：

```ts
  constructor(
    private readonly tasks: TasksService,
    private readonly artifacts: ArtifactService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
  ) {}
```

在 `await this.tasks.assertOwned(...)` 之后、`beginRun` 之前读取：

```ts
    // 配置读取放在预占之前：读失败不应留下 hold。
    const config = await this.settings.getRunConfig();
```

请求体改为：

```ts
        body: JSON.stringify({
          runId,
          sessionId,
          tenantId,
          userId,
          goal,
          messages,
          billing,
          config,
        }),
```

`apps/bff/src/tasks/tasks.controller.test.ts` 的测试模块 providers 增加：

```ts
      {
        provide: SettingsService,
        useValue: {
          getRunConfig: async () => ({
            maxRounds: 3,
            confirmTimeoutMs: 1000,
            codeExecTimeoutMs: 1234,
          }),
        },
      },
```

并在「透传字段」用例里补断言：

```ts
    expect(JSON.parse(lastRunsBody).config).toEqual({
      maxRounds: 3,
      confirmTimeoutMs: 1000,
      codeExecTimeoutMs: 1234,
    });
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: 全部 PASS。

Run: `pnpm --filter @ai-office/bff test -- src/tasks`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/bff/src/tasks/tasks.controller.ts apps/bff/src/tasks/tasks.controller.test.ts apps/agent-runtime/src/run-config.ts apps/agent-runtime/src/run-config.test.ts apps/agent-runtime/src/server.ts apps/agent-runtime/src/agent-loop.ts apps/agent-runtime/src/tools/types.ts apps/agent-runtime/src/tools/code-exec.ts apps/agent-runtime/src/tools/code-exec.test.ts
git commit -m "feat(runtime): 支持按请求下发运行参数"
```

---

## Task 13: KB 切分参数下发

**Files:**
- Modify: `apps/bff/src/kb/kb.service.ts`
- Modify: `apps/bff/src/kb/kb.controller.ts`
- Modify: `apps/bff/src/kb/kb.module.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Test: `apps/bff/src/kb/kb.service.test.ts`
- Test: `apps/bff/src/kb/kb.controller.test.ts`
- Test: `apps/agent-runtime/src/kb-ingest-config.test.ts`

- [ ] **Step 1: 先写 runtime 失败测试**

`apps/agent-runtime/src/kb-ingest-config.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { resolveChunkConfig } from './server';

describe('resolveChunkConfig', () => {
  it('请求值优先', () => {
    expect(resolveChunkConfig({ chunkSize: 600, chunkOverlap: 100 }, {})).toEqual({
      chunkSize: 600,
      chunkOverlap: 100,
    });
  });

  it('越界值回落到 env', () => {
    expect(
      resolveChunkConfig(
        { chunkSize: 10, chunkOverlap: -1 },
        { KB_CHUNK_SIZE: '700', KB_CHUNK_OVERLAP: '50' },
      ),
    ).toEqual({ chunkSize: 700, chunkOverlap: 50 });
  });

  it('overlap ≥ size 时回落到安全值', () => {
    expect(resolveChunkConfig({ chunkSize: 100, chunkOverlap: 100 }, {})).toEqual({
      chunkSize: 100,
      chunkOverlap: 99,
    });
  });

  it('全缺省时用 800/150', () => {
    expect(resolveChunkConfig({}, {})).toEqual({ chunkSize: 800, chunkOverlap: 150 });
  });
});
```

- [ ] **Step 2: BFF 测试补充**

在 `apps/bff/src/kb/kb.service.test.ts` 增加一个用例（沿用文件里已有的 fake fetch 捕获方式；若现有用例没有捕获 body，则用一个局部 fetch 捕获）：

```ts
  it('ingest 把请求级 chunk 参数带给 runtime', async () => {
    let body: Record<string, unknown> | null = null;
    const svc = new KbService(fakePrisma, {
      runtimeUrl: 'http://runtime',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, chunks: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await svc.ingest(
      { id: 'd1', tenantId: 't1', userId: 'u1', filename: 'a.txt', mime: 'text/plain', storageKey: 'k' },
      { chunkSize: 600, chunkOverlap: 100 },
    );
    expect(body).toMatchObject({ chunkSize: 600, chunkOverlap: 100 });
  });
```

`apps/bff/src/kb/kb.controller.test.ts` 的测试模块 providers 增加：

```ts
      {
        provide: SettingsService,
        useValue: { getKbConfig: async () => ({ chunkSize: 600, chunkOverlap: 100 }) },
      },
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- src/kb-ingest-config`
Expected: FAIL —— `resolveChunkConfig` 不存在。

- [ ] **Step 4: runtime 解析 KB 参数**

在 `apps/agent-runtime/src/server.ts` 顶部新增导出函数：

```ts
/** 解析 KB 切分参数：请求值非法时回落 env/默认；overlap 必须小于 size。 */
export function resolveChunkConfig(
  payload: { chunkSize?: unknown; chunkOverlap?: unknown },
  env: NodeJS.ProcessEnv,
): { chunkSize: number; chunkOverlap: number } {
  const int = (raw: unknown, min: number, max: number, fallback: number): number =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max
      ? raw
      : fallback;

  const chunkSize = int(payload.chunkSize, 100, 4000, int(Number(env.KB_CHUNK_SIZE), 100, 4000, 800));
  const requestedOverlap = int(
    payload.chunkOverlap,
    0,
    1000,
    int(Number(env.KB_CHUNK_OVERLAP), 0, 1000, 150),
  );
  const chunkOverlap =
    requestedOverlap < chunkSize ? requestedOverlap : Math.min(150, Math.max(0, chunkSize - 1));
  return { chunkSize, chunkOverlap };
}
```

把 `/kb/ingest` 的 payload 类型扩展：

```ts
          let payload: {
            storageKey?: unknown;
            filename?: unknown;
            mime?: unknown;
            chunkSize?: unknown;
            chunkOverlap?: unknown;
          };
```

`ingest(...)` 的第三个参数改为：

```ts
            const chunks = resolveChunkConfig(payload, process.env);
            const out = await ingest(
              { data, filename, mime },
              { embed: embedding },
              chunks,
            );
```

- [ ] **Step 5: BFF 下发 KB 参数**

`apps/bff/src/kb/kb.service.ts` 的 `ingest` 增加可选参数：

```ts
  async ingest(
    target: IngestTarget,
    chunkConfig?: { chunkSize: number; chunkOverlap: number },
  ): Promise<void> {
```

请求体改为：

```ts
        body: JSON.stringify({
          storageKey: target.storageKey,
          filename: target.filename,
          mime: target.mime,
          ...(chunkConfig ?? {}),
        }),
```

`apps/bff/src/kb/kb.controller.ts`：

```ts
import { SettingsService } from '../settings/settings.service';
```

构造器增加：

```ts
  constructor(
    private readonly kb: KbService,
    @Inject(KB_STORAGE) private readonly storage: KbStorage,
    private readonly settings: SettingsService,
  ) {}
```

上传后的异步摄取改为：

```ts
    const chunkConfig = await this.settings.getKbConfig();
    void this.kb
      .ingest(
        { id: doc.id, tenantId: user.tenantId, userId: user.sub, filename: doc.filename, mime: doc.mime, storageKey },
        chunkConfig,
      )
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`kb doc ${doc.id} 摄取失败: ${msg}`);
        await this.kb.markFailed(doc.id, user.tenantId, user.sub, msg);
      });
```

`apps/bff/src/kb/kb.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { KbController } from './kb.controller';
import { InternalKbController } from './internal-kb.controller';
import { KbService } from './kb.service';
import { KB_STORAGE, createKbStorage } from './storage';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [KbController, InternalKbController],
  providers: [
    KbService,
    { provide: KB_STORAGE, useFactory: () => createKbStorage() },
  ],
})
export class KbModule {}
```

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @ai-office/agent-runtime test -- src/kb-ingest-config`
Expected: PASS。

Run: `pnpm --filter @ai-office/bff test -- src/kb`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/bff/src/kb/kb.service.ts apps/bff/src/kb/kb.controller.ts apps/bff/src/kb/kb.module.ts apps/bff/src/kb/kb.service.test.ts apps/bff/src/kb/kb.controller.test.ts apps/agent-runtime/src/server.ts apps/agent-runtime/src/kb-ingest-config.test.ts
git commit -m "feat(kb): 支持按请求下发切分参数"
```

---

## Task 14: Web 管理端 API 客户端与角色守卫

**Files:**
- Modify: `apps/web/src/lib/api.ts`（导出 `authFetch`）
- Create: `apps/web/src/lib/admin-api.ts`
- Create: `apps/web/src/lib/admin-guard.ts`
- Test: `apps/web/src/lib/admin-guard.test.ts`
- Test: `apps/web/src/lib/admin-api.test.ts`

- [ ] **Step 1: 先写失败测试**

`apps/web/src/lib/admin-guard.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { adminRedirectPath } from './admin-guard';

describe('adminRedirectPath', () => {
  it('管理员不跳转', () => {
    expect(adminRedirectPath('admin')).toBeNull();
  });
  it('成员与空角色跳回工作台', () => {
    expect(adminRedirectPath('member')).toBe('/');
    expect(adminRedirectPath(null)).toBe('/');
  });
});
```

`apps/web/src/lib/admin-api.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { adminErrorText, isForbidden, listAdminUsers } from './admin-api';

afterEach(() => vi.unstubAllGlobals());

function stubWindow() {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => (k === 'ai_office_token' ? 'tok' : null),
      setItem: () => {},
      removeItem: () => {},
    },
  });
}

describe('admin-api', () => {
  it('分页参数拼进 query，空值忽略', async () => {
    stubWindow();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [], total: 0, page: 2, pageSize: 50 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await listAdminUsers({ page: 2, pageSize: 50, q: '' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('/api/admin/users?page=2&pageSize=50');
    expect(String(url)).not.toContain('q=');
  });

  it('403 映射为 forbidden', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    const err = await listAdminUsers({ page: 1 }).catch((e) => e);
    expect(isForbidden(err)).toBe(true);
  });

  it('错误码可读文案', () => {
    expect(adminErrorText(new Error('forbidden'))).toBe('当前账号没有管理权限');
    expect(adminErrorText(new Error('admin_failed_400_last_admin'))).toBe(
      '系统必须保留至少一个启用的管理员',
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-guard src/lib/admin-api`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现客户端**

把 `apps/web/src/lib/api.ts` 中的 `async function authFetch` 改为 `export async function authFetch`。

`apps/web/src/lib/admin-guard.ts`：

```ts
/** 管理端页面守卫：非 admin 返回应跳转的路径。 */
export function adminRedirectPath(role: string | null): string | null {
  return role === 'admin' ? null : '/';
}
```

`apps/web/src/lib/admin-api.ts`：

```ts
import type {
  AdminAuditItemDto,
  AdminCreditsRequest,
  AdminMessageDto,
  AdminModelsDto,
  AdminModelPriceDto,
  AdminPlanDto,
  AdminPlanInput,
  AdminPlanPatch,
  AdminRunDetailDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  AdminSettingDto,
  AdminSubscribeRequest,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  BillingSummaryDto,
  PageDto,
} from '@ai-office/shared';
import { authFetch } from './api';
import { errorText } from './errors';

export function isForbidden(err: unknown): boolean {
  return err instanceof Error && err.message === 'forbidden';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) {
    let code = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // 错误体不一定是 JSON。
    }
    throw new Error(`admin_failed_${res.status}${code ? `_${code}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export function adminErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const map: Record<string, string> = {
    unauthorized: '登录已失效，请重新登录',
    forbidden: '当前账号没有管理权限',
    'admin_failed_400_cannot_modify_self': '不能修改自己的角色或状态',
    'admin_failed_400_last_admin': '系统必须保留至少一个启用的管理员',
    'admin_failed_400_free_not_deactivatable': '免费套餐不可停用',
    'admin_failed_400_model_price_missing': '套餐中的模型必须先配置价格',
    'admin_failed_400_model_in_use': '模型正被启用套餐引用，无法删除',
    'admin_failed_409_model_exists': '该模型价格已存在',
    'admin_failed_404_setting_not_found': '参数不存在',
  };
  if (map[msg]) return map[msg];
  return msg.startsWith('admin_failed_') ? '操作失败，请检查输入' : errorText(err);
}

// ------------------------------------------------------------------ 用户
export function listAdminUsers(
  params: { q?: string; status?: string; role?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminUserItemDto>> {
  return request(`/api/admin/users${query(params)}`);
}

export function getAdminUser(id: string): Promise<AdminUserDetailDto> {
  return request(`/api/admin/users/${encodeURIComponent(id)}`);
}

export function updateAdminUser(id: string, patch: AdminUserPatch): Promise<AdminUserItemDto> {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ------------------------------------------------------------------ 租户
export function listAdminTenants(
  params: { q?: string; planId?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminTenantItemDto>> {
  return request(`/api/admin/tenants${query(params)}`);
}

export function getAdminTenant(id: string): Promise<AdminTenantDetailDto> {
  return request(`/api/admin/tenants/${encodeURIComponent(id)}`);
}

export function adminSubscribeTenant(
  id: string,
  body: AdminSubscribeRequest,
): Promise<BillingSummaryDto> {
  return request(`/api/admin/tenants/${encodeURIComponent(id)}/subscribe`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function adminAdjustCredits(
  id: string,
  body: AdminCreditsRequest,
): Promise<BillingSummaryDto> {
  return request(`/api/admin/tenants/${encodeURIComponent(id)}/credits`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ 套餐
export function listAdminPlans(): Promise<AdminPlanDto[]> {
  return request('/api/admin/plans');
}

export function createAdminPlan(body: AdminPlanInput): Promise<AdminPlanDto> {
  return request('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) });
}

export function updateAdminPlan(id: string, patch: AdminPlanPatch): Promise<AdminPlanDto> {
  return request(`/api/admin/plans/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ------------------------------------------------------------------ 会话
export function listAdminSessions(
  params: { tenantId?: string; userId?: string; q?: string; status?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminSessionItemDto>> {
  return request(`/api/admin/sessions${query(params)}`);
}

export function getAdminSession(id: string): Promise<AdminSessionDetailDto> {
  return request(`/api/admin/sessions/${encodeURIComponent(id)}`);
}

export function listAdminMessages(
  id: string,
  params: { page?: number; pageSize?: number } = {},
): Promise<PageDto<AdminMessageDto>> {
  return request(`/api/admin/sessions/${encodeURIComponent(id)}/messages${query(params)}`);
}

export function archiveAdminSession(id: string): Promise<AdminSessionItemDto> {
  return request(`/api/admin/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'archived' }),
  });
}

// ------------------------------------------------------------------ 任务 / 运行
export function listAdminTasks(
  params: { tenantId?: string; sessionId?: string; userId?: string; status?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminTaskItemDto>> {
  return request(`/api/admin/tasks${query(params)}`);
}

export function getAdminTask(id: string): Promise<AdminTaskDetailDto> {
  return request(`/api/admin/tasks/${encodeURIComponent(id)}`);
}

export function getAdminRun(
  id: string,
  params: { stepPage?: number; stepPageSize?: number } = {},
): Promise<AdminRunDetailDto> {
  return request(`/api/admin/runs/${encodeURIComponent(id)}${query(params)}`);
}

// ------------------------------------------------------------------ 模型
export function getAdminModels(): Promise<AdminModelsDto> {
  return request('/api/admin/models');
}

export function createModelPrice(body: {
  model: string;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
}): Promise<AdminModelPriceDto> {
  return request('/api/admin/model-prices', { method: 'POST', body: JSON.stringify(body) });
}

export function updateModelPrice(
  model: string,
  patch: { inputMilliCreditsPer1k?: number; outputMilliCreditsPer1k?: number },
): Promise<AdminModelPriceDto> {
  return request(`/api/admin/model-prices/${encodeURIComponent(model)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteModelPrice(model: string): Promise<void> {
  return request(`/api/admin/model-prices/${encodeURIComponent(model)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ 参数 / 审计
export function listAdminSettings(): Promise<AdminSettingDto[]> {
  return request('/api/admin/settings');
}

export function updateAdminSetting(key: string, value: number): Promise<AdminSettingDto> {
  return request(`/api/admin/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export function resetAdminSetting(key: string): Promise<void> {
  return request(`/api/admin/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export function listAdminAudit(
  params: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<PageDto<AdminAuditItemDto>> {
  return request(`/api/admin/audit${query(params)}`);
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/web test -- src/lib/admin-guard src/lib/admin-api`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/admin-api.ts apps/web/src/lib/admin-guard.ts apps/web/src/lib/admin-guard.test.ts apps/web/src/lib/admin-api.test.ts
git commit -m "feat(web): 新增管理端 API 客户端与角色守卫"
```

---

## Task 15: Web 管理端外壳、入口与用户/租户页

**Files:**
- Create: `apps/web/src/components/admin-shell.tsx`
- Create: `apps/web/src/app/admin/layout.tsx`
- Create: `apps/web/src/app/admin/page.tsx`
- Create: `apps/web/src/app/admin/users/page.tsx`
- Create: `apps/web/src/app/admin/tenants/page.tsx`
- Modify: `apps/web/src/components/app-shell.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: 管理端样式**

在 `apps/web/src/app/globals.css` 末尾追加：

```css
/* ================================ 管理后台 ================================ */

.admin-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.admin-table th,
.admin-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-size: 13px;
  vertical-align: top;
}

.admin-table th {
  color: var(--ink-2);
  font-weight: 600;
  background: var(--surface-2);
}

.admin-table tr:last-child td {
  border-bottom: none;
}

.admin-table td.numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.admin-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
}

.admin-input {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.admin-btn {
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
}

.admin-btn.primary {
  background: var(--mint);
  border-color: var(--mint);
  color: #fff;
}

.admin-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.admin-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-bottom: 16px;
}

.admin-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-2);
}

.admin-panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 16px;
  margin-bottom: 16px;
}

.admin-pager {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
  color: var(--ink-2);
}

.admin-empty {
  color: var(--ink-3);
  padding: 16px 0;
}

.admin-muted {
  color: var(--ink-3);
  font-size: 12px;
}

.admin-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: var(--ink-3);
}
```

- [ ] **Step 2: 管理端外壳与布局**

`apps/web/src/components/admin-shell.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearToken, getRole } from '../lib/api';
import { adminRedirectPath } from '../lib/admin-guard';

const NAV = [
  { href: '/admin/users', label: '用户管理' },
  { href: '/admin/tenants', label: '会员管理' },
  { href: '/admin/plans', label: '套餐目录' },
  { href: '/admin/sessions', label: '会话管理' },
  { href: '/admin/tasks', label: '任务与运行' },
  { href: '/admin/models', label: '模型配置' },
  { href: '/admin/settings', label: '参数配置' },
  { href: '/admin/audit', label: '审计日志' },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // 角色只在挂载后读取：SSR 阶段没有 localStorage。
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const redirect = adminRedirectPath(getRole());
    if (redirect) {
      router.replace(redirect);
      return;
    }
    setReady(true);
  }, [router]);

  function logout() {
    clearToken();
    router.push('/login');
  }

  if (!ready) return <div className="admin-loading">校验权限…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">管</div>
          <div>
            <div className="brand-name">管理后台</div>
            <div className="brand-sub">平台运营</div>
          </div>
        </div>

        <nav className="nav" aria-label="管理导航">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${pathname.startsWith(item.href) ? ' active' : ''}`}
              aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
            >
              <span className="nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="side-foot">
          <Link className="nav-item" href="/">
            <span className="nav-label">返回工作台</span>
          </Link>
          <button type="button" className="icon-btn" onClick={logout} title="退出登录" aria-label="退出登录">
            退出
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
```

`apps/web/src/app/admin/layout.tsx`：

```tsx
import type { ReactNode } from 'react';
import { AdminShell } from '../../components/admin-shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
```

`apps/web/src/app/admin/page.tsx`：

```tsx
import { redirect } from 'next/navigation';

export default function AdminHome() {
  redirect('/admin/users');
}
```

- [ ] **Step 3: 用户管理页**

`apps/web/src/app/admin/users/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminUserItemDto, AdminUserPatch } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminUsers,
  updateAdminUser,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';
import { errorText } from '../../../lib/errors';

export default function AdminUsersPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminUserItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listAdminUsers({ page, pageSize: 20, q, status, role });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [page, q, status, role, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(user: AdminUserItemDto, body: AdminUserPatch) {
    const before = `角色 ${user.role} / 状态 ${user.status}`;
    const after = `角色 ${body.role ?? user.role} / 状态 ${body.status ?? user.status}`;
    if (!window.confirm(`确认修改 ${user.email}？\n${before} → ${after}`)) return;
    setError('');
    try {
      await updateAdminUser(user.id, body);
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(adminErrorText(err));
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">用户管理</h1>
            <p className="page-sub">跨租户查看用户、状态与角色。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input
            className="admin-input"
            placeholder="搜索邮箱"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
          <select className="admin-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
          <select className="admin-input" value={role} onChange={(e) => { setPage(1); setRole(e.target.value); }}>
            <option value="">全部角色</option>
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的用户</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>租户</th>
                <th>角色</th>
                <th>状态</th>
                <th>注册时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.tenantName}</td>
                  <td>{u.role === 'admin' ? '管理员' : '成员'}</td>
                  <td>{u.status === 'active' ? '启用' : '禁用'}</td>
                  <td>{new Date(u.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => void patch(u, { status: u.status === 'active' ? 'disabled' : 'active' })}
                    >
                      {u.status === 'active' ? '禁用' : '启用'}
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => void patch(u, { role: u.role === 'admin' ? 'member' : 'admin' })}
                    >
                      {u.role === 'admin' ? '设为成员' : '设为管理员'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="admin-pager">
          <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            className="admin-btn"
            disabled={page * 20 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 会员管理页**

`apps/web/src/app/admin/tenants/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminPlanDto,
  AdminTenantDetailDto,
  AdminTenantItemDto,
} from '@ai-office/shared';
import {
  adminAdjustCredits,
  adminErrorText,
  adminSubscribeTenant,
  getAdminTenant,
  isForbidden,
  listAdminPlans,
  listAdminTenants,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminTenantsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminTenantItemDto[]>([]);
  const [plans, setPlans] = useState<AdminPlanDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [planId, setPlanId] = useState('');
  const [detail, setDetail] = useState<AdminTenantDetailDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [data, planRows] = await Promise.all([
        listAdminTenants({ page, pageSize: 20, q, planId }),
        listAdminPlans(),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setPlans(planRows.filter((p) => p.active));
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [page, q, planId, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setError('');
    try {
      setDetail(await getAdminTenant(id));
    } catch (err) {
      handleErr(err);
    }
  }

  async function subscribe(tenantId: string, plan: string) {
    if (!plan) return;
    if (!window.confirm(`确认为该租户开通套餐 ${plan}？`)) return;
    try {
      await adminSubscribeTenant(tenantId, { planId: plan });
      await openDetail(tenantId);
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  async function adjust(tenantId: string) {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value === 0) {
      setError('请输入非零整数积分');
      return;
    }
    if (!window.confirm(`确认调整积分 ${value}？\n备注：${note || '—'}`)) return;
    try {
      await adminAdjustCredits(tenantId, { amount: value, note });
      setAmount('');
      setNote('');
      await openDetail(tenantId);
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">会员管理</h1>
            <p className="page-sub">跨租户查看订阅与积分，并代运营开通套餐、调整额度。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input
            className="admin-input"
            placeholder="搜索租户名"
            value={q}
            onChange={(e) => { setPage(1); setQ(e.target.value); }}
          />
          <select className="admin-input" value={planId} onChange={(e) => { setPage(1); setPlanId(e.target.value); }}>
            <option value="">全部套餐</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">{detail.name}</h2>
            <p className="admin-muted">
              套餐 {detail.planName} · 状态 {detail.subscriptionStatus} · 可用 {detail.balance} · 预占 {detail.reserved}
              {' '}· 用户 {detail.userCount} · 会话 {detail.sessionCount}
            </p>
            <div className="admin-form">
              <label className="admin-field">
                开通套餐
                <select
                  className="admin-input"
                  defaultValue=""
                  onChange={(e) => void subscribe(detail.id, e.target.value)}
                >
                  <option value="">选择套餐…</option>
                  {plans.filter((p) => p.id !== 'free').map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                调整积分（正负整数）
                <input className="admin-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="admin-field">
                备注
                <input className="admin-input" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="button" className="admin-btn primary" onClick={() => void adjust(detail.id)}>
                提交调整
              </button>
              <button type="button" className="admin-btn" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </section>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的租户</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>租户</th>
                <th>套餐</th>
                <th>状态</th>
                <th>可用积分</th>
                <th>预占</th>
                <th>用户数</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.planName}</td>
                  <td>{t.subscriptionStatus}</td>
                  <td className="numeric">{t.balance}</td>
                  <td className="numeric">{t.reserved}</td>
                  <td className="numeric">{t.userCount}</td>
                  <td>{new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button type="button" className="admin-btn" onClick={() => void openDetail(t.id)}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="admin-pager">
          <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button type="button" className="admin-btn" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 工作台增加管理后台入口**

在 `apps/web/src/components/app-shell.tsx` 的 `</nav>` 之前插入：

```tsx
          {role === 'admin' && (
            <Link
              className="nav-item"
              href="/admin/users"
              aria-label="管理后台"
              title="管理后台"
            >
              <span className="nav-label">管理后台</span>
            </Link>
          )}
```

- [ ] **Step 6: 构建验证**

Run: `pnpm --filter @ai-office/web build`
Expected: 构建成功，输出包含 `/admin/users`、`/admin/tenants` 路由。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/app/globals.css apps/web/src/components/admin-shell.tsx apps/web/src/components/app-shell.tsx apps/web/src/app/admin/layout.tsx apps/web/src/app/admin/page.tsx apps/web/src/app/admin/users/page.tsx apps/web/src/app/admin/tenants/page.tsx
git commit -m "feat(web): 新增管理后台外壳与用户/租户页"
```

---

## Task 16: Web 套餐、会话、任务管理页

**Files:**
- Create: `apps/web/src/app/admin/plans/page.tsx`
- Create: `apps/web/src/app/admin/sessions/page.tsx`
- Create: `apps/web/src/app/admin/tasks/page.tsx`

- [ ] **Step 1: 套餐目录页**

`apps/web/src/app/admin/plans/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminPlanDto, AdminPlanInput } from '@ai-office/shared';
import {
  adminErrorText,
  createAdminPlan,
  isForbidden,
  listAdminPlans,
  updateAdminPlan,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

const EMPTY: AdminPlanInput = {
  id: '',
  name: '',
  priceCents: 0,
  monthlyBaseCredits: 0,
  monthlyBonusCredits: 0,
  maxCreditsPerRun: 0,
  rpm: 0,
  allowedModels: [],
  active: true,
};

export default function AdminPlansPage() {
  const router = useRouter();
  const [plans, setPlans] = useState<AdminPlanDto[]>([]);
  const [form, setForm] = useState<AdminPlanInput>(EMPTY);
  const [modelsText, setModelsText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setPlans(await listAdminPlans());
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(plan: AdminPlanDto) {
    setEditing(plan.id);
    setForm({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      monthlyBaseCredits: plan.monthlyBaseCredits,
      monthlyBonusCredits: plan.monthlyBonusCredits,
      maxCreditsPerRun: plan.maxCreditsPerRun,
      rpm: plan.rpm,
      allowedModels: plan.allowedModels,
      active: plan.active,
    });
    setModelsText(plan.allowedModels.join(','));
  }

  function resetForm() {
    setEditing(null);
    setForm(EMPTY);
    setModelsText('');
  }

  async function save() {
    setError('');
    const payload: AdminPlanInput = {
      ...form,
      allowedModels: modelsText.split(',').map((m) => m.trim()).filter(Boolean),
    };
    if (!payload.name.trim()) {
      setError('套餐名称不能为空');
      return;
    }
    const verb = editing ? '保存修改' : '创建套餐';
    if (!window.confirm(`确认${verb} ${payload.name}？`)) return;
    try {
      if (editing) {
        const { id: _id, ...patch } = payload;
        await updateAdminPlan(editing, patch);
      } else {
        await createAdminPlan(payload);
      }
      resetForm();
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">套餐目录</h1>
            <p className="page-sub">停用代替删除；免费套餐不可停用。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <section className="admin-panel">
          <h2 className="billing-heading">{editing ? `编辑 ${editing}` : '新建套餐'}</h2>
          <div className="admin-form">
            <label className="admin-field">
              标识（slug）
              <input
                className="admin-input"
                value={form.id}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
            </label>
            <label className="admin-field">
              名称
              <input className="admin-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="admin-field">
              价格（分/月）
              <input className="admin-input" type="number" value={form.priceCents} onChange={(e) => setForm({ ...form, priceCents: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              月度基础积分
              <input className="admin-input" type="number" value={form.monthlyBaseCredits} onChange={(e) => setForm({ ...form, monthlyBaseCredits: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              月度赠送积分
              <input className="admin-input" type="number" value={form.monthlyBonusCredits} onChange={(e) => setForm({ ...form, monthlyBonusCredits: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              单次上限
              <input className="admin-input" type="number" value={form.maxCreditsPerRun} onChange={(e) => setForm({ ...form, maxCreditsPerRun: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              RPM
              <input className="admin-input" type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
            </label>
            <label className="admin-field">
              允许模型（逗号分隔）
              <input className="admin-input" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
            </label>
            <label className="admin-field">
              启用
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            </label>
            <button type="button" className="admin-btn primary" onClick={() => void save()}>
              {editing ? '保存' : '创建'}
            </button>
            {editing && (
              <button type="button" className="admin-btn" onClick={resetForm}>
                取消
              </button>
            )}
          </div>
        </section>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>标识</th>
                <th>名称</th>
                <th>价格</th>
                <th>额度</th>
                <th>单次上限</th>
                <th>RPM</th>
                <th>模型</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{p.name}</td>
                  <td className="numeric">{p.priceCents}</td>
                  <td className="numeric">{p.monthlyBaseCredits + p.monthlyBonusCredits}</td>
                  <td className="numeric">{p.maxCreditsPerRun}</td>
                  <td className="numeric">{p.rpm}</td>
                  <td>{p.allowedModels.join('、')}</td>
                  <td>{p.active ? '启用' : '停用'}</td>
                  <td>
                    <button type="button" className="admin-btn" onClick={() => startEdit(p)}>
                      编辑
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={p.id === 'free' || !p.active}
                      onClick={() => {
                        if (!window.confirm(`确认停用套餐 ${p.name}？`)) return;
                        void updateAdminPlan(p.id, { active: false })
                          .then(load)
                          .catch(handleErr);
                      }}
                    >
                      停用
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 会话管理页**

`apps/web/src/app/admin/sessions/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminMessageDto, AdminSessionDetailDto, AdminSessionItemDto } from '@ai-office/shared';
import {
  adminErrorText,
  archiveAdminSession,
  getAdminSession,
  isForbidden,
  listAdminMessages,
  listAdminSessions,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminSessionsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminSessionItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [userId, setUserId] = useState('');
  const [detail, setDetail] = useState<AdminSessionDetailDto | null>(null);
  const [messages, setMessages] = useState<AdminMessageDto[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listAdminSessions({ page, pageSize: 20, q, status, tenantId, userId });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [page, q, status, tenantId, userId, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMessages = useCallback(
    async (id: string, targetPage: number) => {
      try {
        const data = await listAdminMessages(id, { page: targetPage, pageSize: 50 });
        setMessages(data.items);
        setMessageTotal(data.total);
        setMessagePage(targetPage);
      } catch (err) {
        handleErr(err);
      }
    },
    [handleErr],
  );

  async function openDetail(id: string) {
    setError('');
    try {
      setDetail(await getAdminSession(id));
      await loadMessages(id, 1);
    } catch (err) {
      handleErr(err);
    }
  }

  async function archive(item: AdminSessionItemDto) {
    if (!window.confirm(`确认归档会话「${item.title}」？归档后普通用户不可见且不可恢复。`)) return;
    try {
      await archiveAdminSession(item.id);
      await load();
      if (detail?.id === item.id) setDetail({ ...detail, status: 'archived' });
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">会话管理</h1>
            <p className="page-sub">跨租户查看会话与消息；归档为不可恢复操作。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input className="admin-input" placeholder="标题" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} />
          <input className="admin-input" placeholder="租户 ID" value={tenantId} onChange={(e) => { setPage(1); setTenantId(e.target.value); }} />
          <input className="admin-input" placeholder="用户 ID" value={userId} onChange={(e) => { setPage(1); setUserId(e.target.value); }} />
          <select className="admin-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="active">活跃</option>
            <option value="archived">已归档</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">{detail.title}</h2>
            <p className="admin-muted">
              {detail.userEmail} · 状态 {detail.status} · 消息 {detail.messageCount} · 任务 {detail.taskCount} · 产物 {detail.artifactCount}
            </p>
            {messages.length === 0 ? (
              <div className="admin-empty">暂无消息</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>seq</th>
                    <th>角色</th>
                    <th>内容</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id}>
                      <td className="numeric">{m.seq}</td>
                      <td>{m.role}</td>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{m.content}</td>
                      <td>{new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="admin-pager">
              <button
                type="button"
                className="admin-btn"
                disabled={messagePage <= 1}
                onClick={() => void loadMessages(detail.id, messagePage - 1)}
              >
                上一页
              </button>
              <span>第 {messagePage} 页 / 共 {messageTotal} 条</span>
              <button
                type="button"
                className="admin-btn"
                disabled={messagePage * 50 >= messageTotal}
                onClick={() => void loadMessages(detail.id, messagePage + 1)}
              >
                下一页
              </button>
              <button type="button" className="admin-btn" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </section>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的会话</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>用户</th>
                <th>租户</th>
                <th>状态</th>
                <th>消息</th>
                <th>任务</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>{s.userEmail}</td>
                  <td>{s.tenantId}</td>
                  <td>{s.status === 'archived' ? '已归档' : '活跃'}</td>
                  <td className="numeric">{s.messageCount}</td>
                  <td className="numeric">{s.taskCount}</td>
                  <td>{new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button type="button" className="admin-btn" onClick={() => void openDetail(s.id)}>
                      查看
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={s.status === 'archived'}
                      onClick={() => void archive(s)}
                    >
                      归档
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="admin-pager">
          <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button type="button" className="admin-btn" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 任务与运行页**

`apps/web/src/app/admin/tasks/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminRunDetailDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  getAdminRun,
  getAdminTask,
  isForbidden,
  listAdminTasks,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminTasksPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminTaskItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tenantId, setTenantId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<AdminTaskDetailDto | null>(null);
  const [run, setRun] = useState<AdminRunDetailDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listAdminTasks({ page, pageSize: 20, tenantId, sessionId, userId, status });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [page, tenantId, sessionId, userId, status, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openTask(id: string) {
    setError('');
    setRun(null);
    try {
      setDetail(await getAdminTask(id));
    } catch (err) {
      handleErr(err);
    }
  }

  async function openRun(id: string) {
    setError('');
    try {
      setRun(await getAdminRun(id, { stepPage: 1, stepPageSize: 100 }));
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">任务与运行</h1>
            <p className="page-sub">只读排障：任务、运行、step 与用量。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input className="admin-input" placeholder="租户 ID" value={tenantId} onChange={(e) => { setPage(1); setTenantId(e.target.value); }} />
          <input className="admin-input" placeholder="会话 ID" value={sessionId} onChange={(e) => { setPage(1); setSessionId(e.target.value); }} />
          <input className="admin-input" placeholder="用户 ID" value={userId} onChange={(e) => { setPage(1); setUserId(e.target.value); }} />
          <select className="admin-input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            <option value="running">运行中</option>
            <option value="done">完成</option>
            <option value="failed">失败</option>
          </select>
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {detail && (
          <section className="admin-panel">
            <h2 className="billing-heading">任务 {detail.id}</h2>
            <p className="admin-muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.goal}</p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>运行</th>
                  <th>状态</th>
                  <th>开始</th>
                  <th>结束</th>
                  <th>积分</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.status}</td>
                    <td>{new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>{r.endedAt ? new Date(r.endedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                    <td className="numeric">{r.credits ?? '—'}</td>
                    <td>
                      <button type="button" className="admin-btn" onClick={() => void openRun(r.id)}>
                        查看 step
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="admin-btn" style={{ marginTop: 12 }} onClick={() => { setDetail(null); setRun(null); }}>
              关闭
            </button>
          </section>
        )}

        {run && (
          <section className="admin-panel">
            <h2 className="billing-heading">运行 {run.id}</h2>
            <p className="admin-muted">
              状态 {run.status} · tokens {run.usage?.inputTokens ?? 0}/{run.usage?.outputTokens ?? 0} · 积分 {run.usage?.credits ?? '—'}
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>seq</th>
                  <th>类型</th>
                  <th>payload</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {run.steps.items.map((s) => (
                  <tr key={s.id}>
                    <td className="numeric">{s.seq}</td>
                    <td>{s.type}</td>
                    <td><code style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(s.payload)}</code></td>
                    <td>{new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="admin-muted" style={{ marginTop: 8 }}>共 {run.steps.total} 条 step</p>
            <button type="button" className="admin-btn" onClick={() => setRun(null)}>
              关闭运行详情
            </button>
          </section>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">没有匹配的任务</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>会话</th>
                <th>目标</th>
                <th>状态</th>
                <th>最近运行</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.sessionId}</td>
                  <td>{t.goal}</td>
                  <td>{t.status}</td>
                  <td>{t.latestRunStatus ?? '—'}</td>
                  <td>{new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button type="button" className="admin-btn" onClick={() => void openTask(t.id)}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="admin-pager">
          <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button type="button" className="admin-btn" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @ai-office/web build`
Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/app/admin/plans/page.tsx apps/web/src/app/admin/sessions/page.tsx apps/web/src/app/admin/tasks/page.tsx
git commit -m "feat(web): 新增套餐/会话/任务管理页"
```

---

## Task 17: Web 模型、参数、审计管理页

**Files:**
- Create: `apps/web/src/app/admin/models/page.tsx`
- Create: `apps/web/src/app/admin/settings/page.tsx`
- Create: `apps/web/src/app/admin/audit/page.tsx`

- [ ] **Step 1: 模型配置页**

`apps/web/src/app/admin/models/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminModelsDto } from '@ai-office/shared';
import {
  adminErrorText,
  createModelPrice,
  deleteModelPrice,
  getAdminModels,
  isForbidden,
  updateModelPrice,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminModelsPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminModelsDto>({ providers: [], prices: [] });
  const [model, setModel] = useState('');
  const [input, setInput] = useState('0');
  const [output, setOutput] = useState('0');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getAdminModels());
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    const name = model.trim();
    if (!name) {
      setError('模型名不能为空');
      return;
    }
    const inputValue = Number(input);
    const outputValue = Number(output);
    const exists = data.prices.some((p) => p.model === name);
    if (!window.confirm(`确认${exists ? '更新' : '新增'}模型价格 ${name}？`)) return;
    try {
      if (exists) {
        await updateModelPrice(name, {
          inputMilliCreditsPer1k: inputValue,
          outputMilliCreditsPer1k: outputValue,
        });
      } else {
        await createModelPrice({
          model: name,
          inputMilliCreditsPer1k: inputValue,
          outputMilliCreditsPer1k: outputValue,
        });
      }
      setModel('');
      setInput('0');
      setOutput('0');
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`确认删除模型价格 ${name}？被启用套餐引用时会被拒绝。`)) return;
    try {
      await deleteModelPrice(name);
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">模型配置</h1>
            <p className="page-sub">查看已配置 provider 的模型；维护每千 token 的毫积分费率。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <section className="admin-panel">
          <h2 className="billing-heading">当前 provider</h2>
          {data.providers.length === 0 ? (
            <div className="admin-empty">未解析到 provider</div>
          ) : (
            <ul className="billing-list">
              {data.providers.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong>：{p.models.join('、')}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="admin-panel">
          <h2 className="billing-heading">新增 / 更新价格</h2>
          <div className="admin-form">
            <label className="admin-field">
              模型名
              <input className="admin-input" value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
            <label className="admin-field">
              输入（毫积分/1K）
              <input className="admin-input" type="number" value={input} onChange={(e) => setInput(e.target.value)} />
            </label>
            <label className="admin-field">
              输出（毫积分/1K）
              <input className="admin-input" type="number" value={output} onChange={(e) => setOutput(e.target.value)} />
            </label>
            <button type="button" className="admin-btn primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : data.prices.length === 0 ? (
          <div className="admin-empty">暂无模型价格</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>输入</th>
                <th>输出</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.prices.map((p) => (
                <tr key={p.model}>
                  <td>{p.model}</td>
                  <td className="numeric">{p.inputMilliCreditsPer1k}</td>
                  <td className="numeric">{p.outputMilliCreditsPer1k}</td>
                  <td>{new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => {
                        setModel(p.model);
                        setInput(String(p.inputMilliCreditsPer1k));
                        setOutput(String(p.outputMilliCreditsPer1k));
                      }}
                    >
                      编辑
                    </button>{' '}
                    <button type="button" className="admin-btn" onClick={() => void remove(p.model)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 参数配置页**

`apps/web/src/app/admin/settings/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminSettingDto } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminSettings,
  resetAdminSetting,
  updateAdminSetting,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

const SOURCE_LABEL: Record<string, string> = {
  db: '数据库',
  env: '环境变量',
  default: '默认值',
};

export default function AdminSettingsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminSettingDto[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rows = await listAdminSettings();
      setItems(rows);
      setDraft(Object.fromEntries(rows.map((r) => [r.key, String(r.value)])));
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(item: AdminSettingDto) {
    const value = Number(draft[item.key]);
    if (!Number.isSafeInteger(value)) {
      setError(`${item.key} 必须是整数`);
      return;
    }
    if (!window.confirm(`确认把 ${item.key} 从 ${item.value} 改为 ${value}？`)) return;
    try {
      await updateAdminSetting(item.key, value);
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  async function reset(item: AdminSettingDto) {
    if (!window.confirm(`确认清除 ${item.key} 的数据库覆盖，恢复环境变量/默认值？`)) return;
    try {
      await resetAdminSetting(item.key);
      await load();
    } catch (err) {
      handleErr(err);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">参数配置</h1>
            <p className="page-sub">修改即时生效：运行参数随下一次 run 下发，KB 参数随下一次摄取下发。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>参数</th>
                <th>生效值</th>
                <th>来源</th>
                <th>范围</th>
                <th>更新人</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td>{item.key}</td>
                  <td>
                    <input
                      className="admin-input"
                      style={{ width: 120 }}
                      value={draft[item.key] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [item.key]: e.target.value })}
                    />
                  </td>
                  <td>{SOURCE_LABEL[item.source] ?? item.source}</td>
                  <td>{item.min}–{item.max}</td>
                  <td>{item.updatedBy ?? '—'}</td>
                  <td>{item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                  <td>
                    <button type="button" className="admin-btn primary" onClick={() => void save(item)}>
                      保存
                    </button>{' '}
                    <button
                      type="button"
                      className="admin-btn"
                      disabled={item.source !== 'db'}
                      onClick={() => void reset(item)}
                    >
                      恢复默认
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 审计日志页**

`apps/web/src/app/admin/audit/page.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminAuditItemDto } from '@ai-office/shared';
import {
  adminErrorText,
  isForbidden,
  listAdminAudit,
} from '../../../lib/admin-api';
import { isUnauthorized } from '../../../lib/api';

export default function AdminAuditPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminAuditItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [actorId, setActorId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (isForbidden(err)) {
        router.push('/');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listAdminAudit({
        page,
        pageSize: 20,
        action,
        targetType,
        targetId,
        actorId,
      });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [page, action, targetType, targetId, actorId, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-head">
          <div>
            <h1 className="page-title">审计日志</h1>
            <p className="page-sub">写操作与敏感查看记录；不含消息正文与密钥。</p>
          </div>
        </header>

        {error && (
          <div className="banner banner-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="admin-toolbar">
          <input className="admin-input" placeholder="动作（如 user.update）" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} />
          <input className="admin-input" placeholder="对象类型" value={targetType} onChange={(e) => { setPage(1); setTargetType(e.target.value); }} />
          <input className="admin-input" placeholder="对象 ID" value={targetId} onChange={(e) => { setPage(1); setTargetId(e.target.value); }} />
          <input className="admin-input" placeholder="操作人 ID" value={actorId} onChange={(e) => { setPage(1); setActorId(e.target.value); }} />
          <span className="admin-muted">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="admin-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-empty">暂无审计记录</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>对象</th>
                <th>摘要</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>{row.actorEmail}</td>
                  <td>{row.action}</td>
                  <td>{row.targetType}{row.targetId ? `: ${row.targetId}` : ''}</td>
                  <td><code style={{ whiteSpace: 'pre-wrap' }}>{row.summary ? JSON.stringify(row.summary) : '—'}</code></td>
                  <td>{row.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="admin-pager">
          <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button type="button" className="admin-btn" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @ai-office/web build`
Expected: 构建成功，`/admin/models`、`/admin/settings`、`/admin/audit` 均出现在路由列表。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/app/admin/models/page.tsx apps/web/src/app/admin/settings/page.tsx apps/web/src/app/admin/audit/page.tsx
git commit -m "feat(web): 新增模型/参数/审计管理页"
```

---

## Task 18: 文档与全量验收

**Files:**
- Modify: `docs/deploy/06-deployment.md`
- Modify: `docs/develop/04-dev-guide.md`
- Modify: `docs/develop/05-dev-plan.md`

- [ ] **Step 1: 部署文档补充管理端**

在 `docs/deploy/06-deployment.md` 末尾追加：

```markdown
## 管理端（M5b-1）

- 管理员预置：`pnpm --filter @ai-office/bff admin:promote <email>`；注册用户一律 `member`。
- 入口：以管理员登录后，工作台侧栏出现「管理后台」，路由前缀 `/admin`；普通用户直连 `/api/admin/*` 返回 403。
- 权限：所有管理接口位于 `/api/admin/*`，受 `JwtGuard + AdminGuard` 保护；`JwtGuard` 每次请求查库，禁用用户立即失效。
- 写操作非破坏性：用户仅可启用/禁用、改角色；会话仅可归档；套餐仅可停用；模型价格可删除但被启用套餐引用时拒绝。
- 审计：写操作与业务写入同事务落 `AdminAuditLog`；敏感查看（用户/租户/会话/消息/任务/运行详情）尽力记录；不记录消息正文、密钥与工具入参全文。
- 参数白名单：`maxRounds`、`confirmTimeoutMs`、`codeExecTimeoutMs`、`kbChunkSize`、`kbChunkOverlap`；来源优先级 DB > 环境变量 > 默认值，页面修改即时生效。
```

- [ ] **Step 2: 开发指南补充本地验证**

在 `docs/develop/04-dev-guide.md` 末尾追加：

```markdown
## 本地验证管理端（M5b-1）

1. `pnpm --filter @ai-office/bff db:push && pnpm --filter @ai-office/bff db:seed:billing`
2. 注册一个普通账号；再用 `pnpm --filter @ai-office/bff admin:promote <email>` 提升为管理员。
3. 启动 `pnpm dev`，用管理员登录后从侧栏进入「管理后台」。
4. 依次验证：用户禁用后既有 token 立即 401；为租户开通套餐与调额；创建/停用套餐；修改模型价格；归档会话后普通用户列表不可见；修改 `maxRounds` 后下一次运行按新值停止；审计页能查到上述记录。
5. 运行 `pnpm test` 与 `pnpm build`。
```

- [ ] **Step 3: 更新开发计划**

把 `docs/develop/05-dev-plan.md` 中 M5b 的描述改为：

```markdown
- M5b-1 管理端（本期）：用户/会员/会话/任务/模型/参数/审计 ✅
- M5b-2 可观测：结构化日志、指标端点与看板（后续）
- M5b-3 队列：任务排队、取消/重试（后续）
```

- [ ] **Step 4: 全量测试与构建**

Run: `pnpm test`
Expected: 所有包测试通过。

Run: `pnpm build`
Expected: 四个包构建成功，web 路由包含 `/admin/*`。

- [ ] **Step 5: 手工验收**

按设计文档 §8.4 逐条验证：

1. 管理员可见「管理后台」，普通用户不可见且直连 `/api/admin/users` 返回 403。
2. 禁用用户后既有 token 立即 401；管理员不能禁用自己。
3. 开通套餐、调整积分后余额与流水正确。
4. 创建/停用套餐、修改模型价格；被引用价格删除被拒。
5. 跨租户会话与任务 step 可见；归档后普通用户列表不可见。
6. 修改 `maxRounds` 后下一次运行按新值停止；修改 KB chunk 参数后摄取生效。
7. 审计页能查到写操作与敏感查看记录。

- [ ] **Step 6: 提交**

```bash
git add docs/deploy/06-deployment.md docs/develop/04-dev-guide.md docs/develop/05-dev-plan.md
git commit -m "docs: 补充管理端部署与验证说明"
```

---

## 自检结果

- **Spec 覆盖**：用户、会员/租户、套餐、会话、消息、任务/运行、模型价格、参数、审计、鉴权重构、运行参数、KB 参数、Web 后台、文档与验收均有对应 Task。
- **非目标**：未引入硬删除、`tenant_admin`、在线密钥、密码重置、任务取消/重试、跨租户导出、OTel。
- **类型一致性**：`PageDto`、`AdminActor`、`SettingSource`、`RunConfig` 在 BFF/Web/shared 中名称一致；审计动作名与设计文档一致。
- **无占位符**：每个代码步骤均给出可直接落盘的内容与可执行命令。
