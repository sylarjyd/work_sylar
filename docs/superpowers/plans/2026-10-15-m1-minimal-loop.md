# M1 最小闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能注册/登录，在网页输入目标，由**真模型**驱动的 Agent Loop 调用联网工具干活，全程 SSE 实时回流。

**Architecture:** 沿用 M0 三层解耦。新增：BFF 侧账号/会话/任务（Postgres + Prisma + JWT），runtime 侧模型网关 + 工具注册表 + 真 Agent Loop（替换 `runFakeAgent`）。模型走 OpenAI 兼容协议（DeepSeek），**无 key 时确定性回退**，保证 CI/本地无外部依赖。

**Tech Stack:** TypeScript 5.6 · Node 22 · pnpm + Turborepo · NestJS 10 (Fastify) · Prisma + Postgres · Next.js 15 / React 19 · vitest · tsx / tsup

**Spec:** `docs/superpowers/specs/2026-10-15-m1-minimal-loop-design.md`

**约定：** 所有命令在仓库根执行。`pnpm --filter <pkg> ...` 指定包。提交信息用中文，格式 `type(scope): 摘要`（全局约定）。

---

## 文件结构

**新增/修改总览**（先定边界，再拆任务）

```
packages/shared
  src/dto.ts                    新增：DTO 与 Run 契约（web↔bff↔runtime 共享类型）
  src/index.ts                  修改：导出 dto

apps/bff
  prisma/schema.prisma          新增：user/tenant/session/message/task/run/step
  src/db/prisma.service.ts       新增：PrismaClient 的 Nest 封装
  src/db/prisma.module.ts        新增：全局 DB 模块
  src/auth/jwt.ts               新增：签发/校验 JWT（纯函数，可测）
  src/auth/auth.service.ts       新增：注册/登录业务
  src/auth/auth.controller.ts    新增：POST /api/auth/register|login
  src/auth/jwt.guard.ts          新增：Guard，校验 Bearer
  src/auth/current-user.ts       新增：@CurrentUser 参数装饰器
  src/sessions/sessions.service.ts   新增：会话/消息读写
  src/sessions/sessions.controller.ts 新增：会话 CRUD
  src/tasks/tasks.service.ts     新增：建 task/run、转发 runtime、写 step
  src/tasks/tasks.controller.ts  新增：POST /api/sessions/:id/tasks（SSE）
  src/stream/sse-proxy.ts        新增：从 M0 抽出的裸 socket SSE 转发工具
  src/app.module.ts             修改：装配新模块
  src/stream/*                  删除：被 tasks + sse-proxy 取代

apps/agent-runtime
  src/model/types.ts            新增：ModelGateway 接口与 Chat 类型
  src/model/openai-compat.ts     新增：OpenAI 兼容 provider（DeepSeek）
  src/model/mock-gateway.ts      新增：无 key 时的确定性回退
  src/model/create-gateway.ts    新增：按 env 选择 provider
  src/tools/types.ts            新增：Tool 接口
  src/tools/web-search.ts        新增：web.search（Tavily / DuckDuckGo）
  src/tools/web-fetch.ts         新增：web.fetch（HTML→文本）
  src/tools/registry.ts          新增：内置工具集
  src/agent-loop.ts             新增：runAgent（真循环）
  src/server.ts                 修改：/prompt → /runs
  src/fake-agent.ts             删除
  src/fake-agent.test.ts        删除

apps/web
  src/lib/api.ts                新增：带 JWT 的 fetch 封装 + token 存取
  src/app/login/page.tsx         新增：登录/注册页
  src/app/page.tsx              修改：工作台（带 JWT 调 /api/sessions/:id/tasks）
  src/lib/render-step.ts         新增：按 step.type 生成展示文本（可测）

.env.example                    新增：配置样例（占位）
```

---

## Task 1: `shared` —— 扩展协议（DTO 与 Run 契约）

**Files:**
- Create: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 创建 `packages/shared/src/dto.ts`**

```ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * web → bff → runtime 的「下达目标」请求。
 * runId 由 BFF 生成并透传给 runtime，保证落库（run/step）与 SSE 事件流对齐。
 */
export interface RunRequest {
  runId: string;
  sessionId: string;
  goal: string;
  messages: ChatMessage[];
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface CreateSessionRequest {
  title?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  role: ChatRole;
  content: string;
  seq: number;
}

export interface CreateTaskRequest {
  goal: string;
}
```

- [ ] **Step 2: 修改 `packages/shared/src/index.ts` 导出**

```ts
export * from './protocol';
export * from './dto';
```

- [ ] **Step 3: 构建与测试**

Run: `pnpm --filter @ai-office/shared build && pnpm --filter @ai-office/shared test`
Expected: 构建成功；测试 PASS（本文件为纯类型，无运行时行为，不加测试）。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/index.ts
git commit -m "feat(shared): 补 M1 所需的 DTO 与 Run 契约"
```

---

## Task 2: `bff` —— Prisma/Postgres 接入与数据模型

**Files:**
- Create: `apps/bff/prisma/schema.prisma`
- Create: `apps/bff/src/db/prisma.service.ts`
- Create: `apps/bff/src/db/prisma.module.ts`
- Create: `apps/bff/docker-compose.yml`
- Modify: `apps/bff/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: 装依赖并初始化 Prisma**

```bash
pnpm --filter @ai-office/bff add @prisma/client
pnpm --filter @ai-office/bff add -D prisma
```

- [ ] **Step 2: 创建 `apps/bff/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id        String   @id @default(uuid())
  type      String   @default("personal")
  name      String
  plan      String   @default("free")
  createdAt DateTime @default(now())
  users     User[]
  sessions  Session[]
}

model User {
  id           String   @id @default(uuid())
  tenantId     String
  email        String   @unique
  passwordHash String
  status       String   @default("active")
  createdAt    DateTime @default(now())
  tenant       Tenant   @relation(fields: [tenantId], references: [id])
  sessions     Session[]

  @@index([tenantId])
}

model Session {
  id        String   @id @default(uuid())
  tenantId  String
  userId    String
  title     String   @default("新会话")
  status    String   @default("active")
  createdAt DateTime @default(now())
  tenant    Tenant   @relation(fields: [tenantId], references: [id])
  user      User     @relation(fields: [userId], references: [id])
  messages  Message[]
  tasks     Task[]

  @@index([tenantId, userId])
}

model Message {
  id        String   @id @default(uuid())
  sessionId String
  role      String
  content   String
  seq       Int
  tokens    Int?
  createdAt DateTime @default(now())
  session   Session  @relation(fields: [sessionId], references: [id])

  @@unique([sessionId, seq])
}

model Task {
  id        String   @id @default(uuid())
  sessionId String
  goal      String
  status    String   @default("queued")
  createdAt DateTime @default(now())
  session   Session  @relation(fields: [sessionId], references: [id])
  runs      Run[]

  @@index([sessionId])
}

model Run {
  id        String    @id @default(uuid())
  taskId    String
  status    String    @default("running")
  startedAt DateTime  @default(now())
  endedAt   DateTime?
  task      Task      @relation(fields: [taskId], references: [id])
  steps     Step[]

  @@index([taskId])
}

model Step {
  id      String   @id @default(uuid())
  runId   String
  seq     Int
  type    String
  payload Json
  ts      DateTime @default(now())
  run     Run      @relation(fields: [runId], references: [id])

  @@unique([runId, seq])
}
```

- [ ] **Step 3: 创建 `apps/bff/docker-compose.yml`**（本地 PG，dev 与测试共用一个实例、不同 database）

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ai_office
      POSTGRES_PASSWORD: ai_office
      POSTGRES_DB: ai_office
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

- [ ] **Step 4: 加脚本到 `apps/bff/package.json`**

把 `"scripts"` 中 `"test"` 一行后追加（保持 JSON 合法，注意逗号）：

```json
    "db:up": "docker compose up -d",
    "db:push": "prisma db push",
    "db:generate": "prisma generate",
```

- [ ] **Step 4b: 放行 Prisma 的构建脚本（否则干净检出会缺 client）**

pnpm 10 默认不跑依赖的 postinstall，而 `@prisma/client` 正是靠 postinstall 自动执行 `prisma generate`。不放行的话，新克隆/CI 上 `typecheck`/`test` 会因缺 `.prisma/client` 而失败（本机因已手动 generate 过而掩盖）。在 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 追加：

```yaml
onlyBuiltDependencies:
  - esbuild
  - "@swc/core"
  - sharp
  - unrs-resolver
  # @prisma/client 的 postinstall 会自动跑 `prisma generate`；不放行则干净检出缺 client。
  - "@prisma/client"
  - prisma
```

改完执行 `pnpm install` 触发一次 generate。

- [ ] **Step 5: 确认 `.gitignore` 忽略 `.env`**

在仓库根 `.gitignore` 确认存在（无则追加）以下行：

```
.env
.env.*
!.env.example
```

- [ ] **Step 6: 起库、生成 client、建表**

```bash
cd apps/bff && docker compose up -d && cd ../..
export DATABASE_URL="postgresql://ai_office:ai_office@localhost:5432/ai_office?schema=public"
pnpm --filter @ai-office/bff db:generate
pnpm --filter @ai-office/bff db:push
```
Expected: `prisma generate` 输出 `Generated Prisma Client`；`db push` 输出 `Your database is now in sync with your schema.`

- [ ] **Step 7: 创建 `apps/bff/src/db/prisma.service.ts`**

```ts
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 8: 创建 `apps/bff/src/db/prisma.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

- [ ] **Step 9: 类型检查**

Run: `pnpm --filter @ai-office/bff typecheck`
Expected: PASS（无输出）。

- [ ] **Step 10: Commit**

```bash
git add apps/bff/prisma apps/bff/src/db apps/bff/docker-compose.yml apps/bff/package.json pnpm-lock.yaml .gitignore
git commit -m "feat(bff): 接入 Prisma/Postgres 并落 M1 数据模型"
```

> 注：`prisma` / `@prisma/client` 固定为 **6.19.3**。registry 上的 `latest` 已是 7/8（RC），Prisma 7+ 要求 generator 显式 `output` 且改从生成路径导入 `PrismaClient`，与本计划 schema/import 不兼容。若后续升级 Prisma 需一并调整 `schema.prisma` 与导入方式。

---

## Task 3: `bff` —— 认证（注册 / 登录 / JWT guard）

**Files:**
- Create: `apps/bff/src/auth/jwt.ts`
- Create: `apps/bff/src/auth/auth.service.ts`
- Create: `apps/bff/src/auth/auth.controller.ts`
- Create: `apps/bff/src/auth/jwt.guard.ts`
- Create: `apps/bff/src/auth/current-user.ts`
- Test: `apps/bff/src/auth/jwt.test.ts`
- Modify: `apps/bff/package.json`（加依赖）

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @ai-office/bff add @nestjs/jwt argon2
```

- [ ] **Step 2: 写失败测试 `apps/bff/src/auth/jwt.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { signToken, verifyToken } from './jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

describe('jwt', () => {
  it('签发后能校验回原 payload', () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    expect(verifyToken(token)).toMatchObject({ sub: 'u1', tenantId: 't1' });
  });

  it('被篡改的 token 校验失败', () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    expect(() => verifyToken(token + 'x')).toThrow();
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/bff test jwt`
Expected: FAIL —— `Cannot find module './jwt'`。

- [ ] **Step 4: 创建 `apps/bff/src/auth/jwt.ts`**

```ts
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  tenantId: string;
}

/** 每次调用读取 env：测试在 beforeAll 里设置 JWT_SECRET，模块级读取会拿到旧值。 */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET 未设置');
  return s;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret()) as JwtPayload;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/bff test jwt`
Expected: PASS（2 tests）。

- [ ] **Step 6: 创建 `apps/bff/src/auth/auth.service.ts`**

```ts
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../db/prisma.service';
import { signToken } from './jwt';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@ai-office/shared';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(req: RegisterRequest): Promise<AuthResponse> {
    const existing = await this.prisma.user.findUnique({ where: { email: req.email } });
    if (existing) throw new ConflictException('email_taken');

    const passwordHash = await argon2.hash(req.password);
    // 个人用户 = 一个 personal 租户；注册时自动创建（为多租户预留，上游 §4）。
    const user = await this.prisma.user.create({
      data: {
        email: req.email,
        passwordHash,
        tenant: { create: { type: 'personal', name: req.email } },
      },
    });
    return this.issue(user.id, user.tenantId, user.email);
  }

  async login(req: LoginRequest): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: req.email } });
    // 邮箱不存在与密码错误返回同一个错误，避免账号枚举。
    if (!user || !(await argon2.verify(user.passwordHash, req.password))) {
      throw new UnauthorizedException('invalid_credentials');
    }
    return this.issue(user.id, user.tenantId, user.email);
  }

  private issue(userId: string, tenantId: string, email: string): AuthResponse {
    return {
      token: signToken({ sub: userId, tenantId }),
      user: { id: userId, email },
    };
  }
}
```

- [ ] **Step 7: 创建 `apps/bff/src/auth/jwt.guard.ts`**

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { verifyToken, type JwtPayload } from './jwt';

export interface AuthedRequest extends FastifyRequest {
  user: JwtPayload;
}

@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing_token');
    try {
      req.user = verifyToken(token);
    } catch {
      throw new UnauthorizedException('invalid_token');
    }
    return true;
  }
}
```

- [ ] **Step 8: 创建 `apps/bff/src/auth/current-user.ts`**

```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './jwt.guard';
import type { JwtPayload } from './jwt';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);
```

- [ ] **Step 9: 创建 `apps/bff/src/auth/auth.controller.ts`**

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@ai-office/shared';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterRequest): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Post('login')
  login(@Body() body: LoginRequest): Promise<AuthResponse> {
    return this.auth.login(body);
  }
}
```

- [ ] **Step 10: 写集成测试 `apps/bff/src/auth/auth.controller.test.ts`**（用假 Prisma，无需真库）

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import * as argon2 from 'argon2';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from '../db/prisma.service';

// 极简内存假库：只实现 AuthService 用到的三个方法。
const users = new Map<string, { id: string; email: string; passwordHash: string; tenantId: string }>();
const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null,
    create: async ({ data }: { data: { email: string; passwordHash: string } }) => {
      const row = { id: `u${users.size + 1}`, tenantId: `t${users.size + 1}`, ...data };
      users.set(data.email, row);
      return row;
    },
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [AuthService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('AuthController', () => {
  it('注册返回 token，且库里存的是哈希而非明文', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('a@b.com');
    const stored = users.get('a@b.com')!;
    expect(stored.passwordHash).not.toBe('pw123456');
    expect(await argon2.verify(stored.passwordHash, 'pw123456')).toBe(true);
  });

  it('重复邮箱注册返回 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('密码错误登录返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 11: 运行测试**

Run: `pnpm --filter @ai-office/bff test auth`
Expected: PASS（5 tests：jwt 2 + controller 3）。

- [ ] **Step 12: 类型检查**

Run: `pnpm --filter @ai-office/bff typecheck`
Expected: PASS。

- [ ] **Step 13: Commit**

```bash
git add apps/bff/src/auth apps/bff/package.json pnpm-lock.yaml
git commit -m "feat(bff): 账号注册登录与 JWT 鉴权"
```

---

## Task 4: `bff` —— 会话与消息 CRUD

**Files:**
- Create: `apps/bff/src/sessions/sessions.service.ts`
- Create: `apps/bff/src/sessions/sessions.controller.ts`
- Test: `apps/bff/src/sessions/sessions.controller.test.ts`

- [ ] **Step 1: 创建 `apps/bff/src/sessions/sessions.service.ts`**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type {
  CreateSessionRequest,
  MessageDto,
  SessionSummary,
} from '@ai-office/shared';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<SessionSummary[]> {
    const rows = await this.prisma.session.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt.toISOString() }));
  }

  async create(
    tenantId: string,
    userId: string,
    req: CreateSessionRequest,
  ): Promise<SessionSummary> {
    const s = await this.prisma.session.create({
      data: { tenantId, userId, title: req.title ?? '新会话' },
    });
    return { id: s.id, title: s.title, createdAt: s.createdAt.toISOString() };
  }

  /** 校验会话归属（tenant 强制行级隔离，上游 §7）：非本租户/用户一律 404，不泄露存在性。 */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    const s = await this.prisma.session.findFirst({ where: { id: sessionId, tenantId, userId } });
    if (!s) throw new NotFoundException('session_not_found');
  }

  async messages(sessionId: string, tenantId: string, userId: string): Promise<MessageDto[]> {
    await this.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      role: m.role as MessageDto['role'],
      content: m.content,
      seq: m.seq,
    }));
  }
}
```

- [ ] **Step 2: 创建 `apps/bff/src/sessions/sessions.controller.ts`**

```ts
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import type {
  CreateSessionRequest,
  MessageDto,
  SessionSummary,
} from '@ai-office/shared';

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<SessionSummary[]> {
    return this.sessions.list(user.tenantId, user.sub);
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() body: CreateSessionRequest,
  ): Promise<SessionSummary> {
    return this.sessions.create(user.tenantId, user.sub, body ?? {});
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<MessageDto[]> {
    return this.sessions.messages(id, user.tenantId, user.sub);
  }
}
```

- [ ] **Step 3: 写测试 `apps/bff/src/sessions/sessions.controller.test.ts`**

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const tenantId = 't1';
const userId = 'u1';
let token: string;

// 内存假库：会话归属用 tenantId/userId 过滤，模拟行级隔离。
const sessions: { id: string; tenantId: string; userId: string; title: string; createdAt: Date }[] = [];

const fakePrisma = {
  session: {
    findMany: async ({ where }: { where: { tenantId: string; userId: string } }) =>
      sessions.filter((s) => s.tenantId === where.tenantId && s.userId === where.userId),
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      sessions.find(
        (s) => s.id === where.id && s.tenantId === where.tenantId && s.userId === where.userId,
      ) ?? null,
    create: async ({ data }: { data: { tenantId: string; userId: string; title: string } }) => {
      const row = { id: `s${sessions.length + 1}`, createdAt: new Date(), ...data };
      sessions.push(row);
      return row;
    },
  },
  message: { findMany: async () => [] },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  token = signToken({ sub: userId, tenantId });
  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController],
    providers: [SessionsService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

const auth = { authorization: `Bearer ${token}` };

describe('SessionsController', () => {
  it('未带 token 访问返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('创建后可列出会话', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: auth,
      payload: { title: '第一个会话' },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth });
    const arr = JSON.parse(list.payload);
    expect(arr).toHaveLength(1);
    expect(arr[0].title).toBe('第一个会话');
  });

  it('访问不属于自己的会话返回 404', async () => {
    const other = signToken({ sub: 'u2', tenantId: 't2' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/s1/messages',
      headers: { authorization: `Bearer ${other}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-office/bff test sessions`
Expected: PASS（3 tests）。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @ai-office/bff typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/sessions
git commit -m "feat(bff): 会话与消息 CRUD（含租户行级隔离）"
```

---

## Task 5: `agent-runtime` —— 模型网关（含无 key 回退）

**Files:**
- Create: `apps/agent-runtime/src/model/types.ts`
- Create: `apps/agent-runtime/src/model/openai-compat.ts`
- Create: `apps/agent-runtime/src/model/mock-gateway.ts`
- Create: `apps/agent-runtime/src/model/create-gateway.ts`
- Test: `apps/agent-runtime/src/model/create-gateway.test.ts`
- Test: `apps/agent-runtime/src/model/openai-compat.test.ts`

- [ ] **Step 1: 创建 `apps/agent-runtime/src/model/types.ts`**

```ts
import type { ChatMessage } from '@ai-office/shared';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}

/** 模型网关：M1 只暴露「一次 chat 补全」；多模型路由/限流/埋点留到 M5，不动上层。 */
export interface ModelGateway {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
```

- [ ] **Step 2: 写失败测试 `apps/agent-runtime/src/model/create-gateway.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from './create-gateway';
import { MockGateway } from './mock-gateway';
import { OpenAICompatGateway } from './openai-compat';

describe('createGateway', () => {
  it('无 DEEPSEEK_API_KEY 时回退 MockGateway', () => {
    expect(createGateway({})).toBeInstanceOf(MockGateway);
  });

  it('有 key 时使用 OpenAI 兼容 provider', () => {
    expect(createGateway({ DEEPSEEK_API_KEY: 'k' })).toBeInstanceOf(OpenAICompatGateway);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test create-gateway`
Expected: FAIL —— `Cannot find module './create-gateway'`。

- [ ] **Step 4: 创建 `apps/agent-runtime/src/model/mock-gateway.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

/**
 * 无 key 时的确定性回退：首轮发起一次 web.search，第二轮（已见 tool 结果）产出结论。
 * 让单测 / CI / 本地演示不依赖任何外部服务，同时保留完整的工具调用路径。
 */
export class MockGateway implements ModelGateway {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    const goal = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (!hasToolResult && goal) {
      return {
        content: `我需要先检索资料：${goal}`,
        toolCalls: [{ id: randomUUID(), name: 'web.search', args: { query: goal } }],
        usage: { input: 10, output: 8 },
      };
    }
    return {
      content: `根据检索结果，关于「${goal}」的结论已生成。`,
      toolCalls: [],
      usage: { input: 20, output: 12 },
    };
  }
}
```

- [ ] **Step 5: 创建 `apps/agent-runtime/src/model/openai-compat.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

interface OpenAIResponse {
  choices?: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 走 OpenAI 兼容的 /chat/completions（DeepSeek 即此协议）。 */
export class OpenAICompatGateway implements ModelGateway {
  constructor(private readonly cfg: OpenAICompatConfig) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: req.messages,
        tools: req.tools.length
          ? req.tools.map((t) => ({ type: 'function', function: t }))
          : undefined,
      }),
    });
    if (!res.ok) throw new Error(`model_http_${res.status}`);
    const data = (await res.json()) as OpenAIResponse;
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      })),
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
```

- [ ] **Step 6: 创建 `apps/agent-runtime/src/model/create-gateway.ts`**

```ts
import type { ModelGateway } from './types';
import { OpenAICompatGateway } from './openai-compat';
import { MockGateway } from './mock-gateway';

export function createGateway(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return new MockGateway();
  return new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.MODEL_NAME ?? 'deepseek-chat',
  });
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test create-gateway`
Expected: PASS（2 tests）。

- [ ] **Step 8: 写契约测试 `apps/agent-runtime/src/model/openai-compat.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAICompatGateway } from './openai-compat';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // 断言请求体符合 OpenAI 协议
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '好的',
                tool_calls: [
                  { id: 'c1', function: { name: 'web.search', arguments: '{"query":"x"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
          // 回显模型名以便断言
          echoModel: parsed.model,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('OpenAICompatGateway', () => {
  it('解析 content/tool_calls/usage', async () => {
    const gw = new OpenAICompatGateway({ baseUrl, apiKey: 'k', model: 'deepseek-chat' });
    const resp = await gw.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'web.search', description: 'd', parameters: {} }],
    });
    expect(resp.content).toBe('好的');
    expect(resp.toolCalls).toEqual([{ id: 'c1', name: 'web.search', args: { query: 'x' } }]);
    expect(resp.usage).toEqual({ input: 3, output: 5 });
  });

  it('非 2xx 抛错', async () => {
    const bad = createServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await new Promise<void>((r) => bad.listen(0, r));
    const addr = bad.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const gw = new OpenAICompatGateway({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      apiKey: 'k',
      model: 'm',
    });
    await expect(gw.chat({ messages: [], tools: [] })).rejects.toThrow('model_http_500');
    await new Promise<void>((r) => bad.close(() => r()));
  });
});
```

- [ ] **Step 9: 运行全部 runtime 测试 + 类型检查**

Run: `pnpm --filter @ai-office/agent-runtime test && pnpm --filter @ai-office/agent-runtime typecheck`
Expected: PASS。

- [ ] **Step 10: Commit**

```bash
git add apps/agent-runtime/src/model
git commit -m "feat(runtime): 模型网关（OpenAI 兼容 + 无 key 确定性回退）"
```

---

## Task 6: `agent-runtime` —— 工具注册表 + `web.search` / `web.fetch`

**Files:**
- Create: `apps/agent-runtime/src/tools/types.ts`
- Create: `apps/agent-runtime/src/tools/web-search.ts`
- Create: `apps/agent-runtime/src/tools/web-fetch.ts`
- Create: `apps/agent-runtime/src/tools/registry.ts`
- Test: `apps/agent-runtime/src/tools/web-search.test.ts`
- Test: `apps/agent-runtime/src/tools/web-fetch.test.ts`

- [ ] **Step 1: 创建 `apps/agent-runtime/src/tools/types.ts`**

```ts
export interface Tool {
  name: string;
  description: string;
  /** JSON-Schema：直接喂给模型做 function-calling。 */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}
```

- [ ] **Step 2: 写失败测试 `apps/agent-runtime/src/tools/web-fetch.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { htmlToText, createWebFetchTool } from './web-fetch';

describe('htmlToText', () => {
  it('剥离标签、脚本与多余空白', () => {
    const html = '<html><head><style>.a{}</style></head><body><h1>标题</h1><script>x=1</script><p>正  文</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('标题');
    expect(text).toContain('正 文');
    expect(text).not.toContain('<h1>');
    expect(text).not.toContain('x=1');
  });
});

describe('createWebFetchTool', () => {
  it('参数 schema 声明 url', () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe('web.fetch');
    expect(JSON.stringify(tool.parameters)).toContain('url');
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test web-fetch`
Expected: FAIL —— `Cannot find module './web-fetch'`。

- [ ] **Step 4: 创建 `apps/agent-runtime/src/tools/web-fetch.ts`**

```ts
import type { Tool } from './types';

const MAX_CHARS = 8000;

/** 极简 HTML→文本：去 script/style、去标签、压缩空白。M1 不引入解析库。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function createWebFetchTool(): Tool {
  return {
    name: 'web.fetch',
    description: '抓取指定 URL 的网页并返回其纯文本内容（已截断到上限）。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的完整 URL' } },
      required: ['url'],
    },
    async execute(args) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new Error('invalid_url');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch_http_${res.status}`);
      const text = htmlToText(await res.text());
      return { url, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
    },
  };
}
```

- [ ] **Step 5: 写失败测试 `apps/agent-runtime/src/tools/web-search.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createWebSearchTool, type SearchProvider } from './web-search';

const stub: SearchProvider = {
  async search(query) {
    return [{ title: `R:${query}`, url: 'https://e.com', snippet: 's' }];
  },
};

describe('createWebSearchTool', () => {
  it('把 query 传给 provider 并返回结果', async () => {
    const tool = createWebSearchTool(stub);
    expect(tool.name).toBe('web.search');
    const out = (await tool.execute({ query: '竞品' })) as { results: { title: string }[] };
    expect(out.results[0].title).toBe('R:竞品');
  });

  it('缺少 query 报错', async () => {
    const tool = createWebSearchTool(stub);
    await expect(tool.execute({})).rejects.toThrow('missing_query');
  });
});
```

- [ ] **Step 6: 创建 `apps/agent-runtime/src/tools/web-search.ts`**

```ts
import type { Tool } from './types';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

/** Tavily 优先（有 key），否则 DuckDuckGo 免 key 回退。 */
export function createSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  if (env.TAVILY_API_KEY) return tavilyProvider(env.TAVILY_API_KEY);
  return duckDuckGoProvider();
}

export function createWebSearchTool(provider: SearchProvider): Tool {
  return {
    name: 'web.search',
    description: '联网搜索，返回若干条 {title,url,snippet} 结果。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('missing_query');
      return { results: await provider.search(query) };
    },
  };
}

function tavilyProvider(apiKey: string): SearchProvider {
  return {
    async search(query) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
      });
      if (!res.ok) throw new Error(`tavily_http_${res.status}`);
      const data = (await res.json()) as { results?: SearchResult[] };
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet ?? '',
      }));
    },
  };
}

function duckDuckGoProvider(): SearchProvider {
  return {
    async search(query) {
      // 免 key 的 instant answer 接口：够 M1 演示用，质量不如 Tavily。
      const res = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      );
      if (!res.ok) throw new Error(`ddg_http_${res.status}`);
      const data = (await res.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: { Text?: string; FirstURL?: string }[];
      };
      const results: SearchResult[] = [];
      if (data.AbstractText && data.AbstractURL) {
        results.push({ title: query, url: data.AbstractURL, snippet: data.AbstractText });
      }
      for (const t of data.RelatedTopics ?? []) {
        if (t.Text && t.FirstURL) results.push({ title: t.Text, url: t.FirstURL, snippet: t.Text });
      }
      return results.slice(0, 5);
    },
  };
}
```

- [ ] **Step 7: 创建 `apps/agent-runtime/src/tools/registry.ts`**

```ts
import type { Tool } from './types';
import { createWebSearchTool, createSearchProvider } from './web-search';
import { createWebFetchTool } from './web-fetch';

/** M1 内置工具集：web.search + web.fetch（其余留 M2/M4）。 */
export function createTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  return [createWebSearchTool(createSearchProvider(env)), createWebFetchTool()];
}
```

- [ ] **Step 8: 运行测试 + 类型检查**

Run: `pnpm --filter @ai-office/agent-runtime test && pnpm --filter @ai-office/agent-runtime typecheck`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add apps/agent-runtime/src/tools
git commit -m "feat(runtime): 工具注册表与联网工具 web.search/web.fetch"
```

---

## Task 7: `agent-runtime` —— 真 Agent Loop + `/runs` 端点（替换 fake-agent）

**Files:**
- Create: `apps/agent-runtime/src/agent-loop.ts`
- Test: `apps/agent-runtime/src/agent-loop.test.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Modify: `apps/agent-runtime/src/server.test.ts`
- Delete: `apps/agent-runtime/src/fake-agent.ts`, `apps/agent-runtime/src/fake-agent.test.ts`

- [ ] **Step 1: 写失败测试 `apps/agent-runtime/src/agent-loop.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { runAgent } from './agent-loop';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';
import type { AgentEvent, RunRequest } from '@ai-office/shared';

function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  return (async () => {
    const out: AgentEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  })();
}

const echoTool: Tool = {
  name: 'web.search',
  description: 'd',
  parameters: {},
  async execute(args) {
    return { results: [{ title: 'T', url: 'u', snippet: String(args.query) }] };
  },
};

const req: RunRequest = {
  runId: 'r1',
  sessionId: 's1',
  goal: '查竞品',
  messages: [{ role: 'user', content: '查竞品' }],
};

describe('runAgent', () => {
  it('调工具一轮后结束，产出 think/tool_call/tool_result', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '先搜索',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: '竞品' } }],
            usage: { input: 1, output: 1 },
          };
        }
        return { content: '结论', toolCalls: [], usage: { input: 2, output: 2 } };
      },
    };
    const usages: { input: number; output: number }[] = [];
    const events = await collect(
      runAgent(req, { gateway, tools: [echoTool], onUsage: (u) => usages.push(u) }),
    );
    expect(events.map((e) => e.type)).toEqual(['think', 'tool_call', 'tool_result', 'think']);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(usages).toEqual([{ input: 3, output: 3 }]);
  });

  it('无工具调用即结束（单轮）', async () => {
    const gateway: ModelGateway = {
      async chat() {
        return { content: '直接回答', toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [] }));
    expect(events.map((e) => e.type)).toEqual(['think']);
  });

  it('达到轮次上限后停止', async () => {
    const gateway: ModelGateway = {
      async chat() {
        return {
          content: '继续',
          toolCalls: [{ id: 'c', name: 'web.search', args: { query: 'x' } }],
          usage: { input: 1, output: 1 },
        };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [echoTool], maxRounds: 2 }));
    // 2 轮 × (think + tool_call + tool_result)
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
  });

  it('工具报错不中断循环，记为失败结果', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '试试',
            toolCalls: [{ id: 'c1', name: 'boom', args: {} }],
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 } };
      },
    };
    const badTool: Tool = {
      name: 'boom',
      description: 'd',
      parameters: {},
      async execute() {
        throw new Error('kaboom');
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [badTool] }));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.payload.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test agent-loop`
Expected: FAIL —— `Cannot find module './agent-loop'`。

- [ ] **Step 3: 创建 `apps/agent-runtime/src/agent-loop.ts`**

```ts
import type { AgentEvent, RunRequest } from '@ai-office/shared';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';

export interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;
  onUsage?: (usage: { input: number; output: number }) => void;
}

const DEFAULT_MAX_ROUNDS = 8;

/**
 * plan → act → observe 循环（上游 §5.1 的 M1 精简实现）。
 * 每次模型返回无 tool_call 即结束；受 maxRounds 上限保护，防失控。
 */
export async function* runAgent(req: RunRequest, deps: RunDeps): AsyncGenerator<AgentEvent> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const schemas = deps.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const messages = [...req.messages];
  let seq = 0;
  let usage = { input: 0, output: 0 };
  const step = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
    runId: req.runId,
    seq: seq++,
    type,
    payload,
    ts: Date.now(),
  });

  for (let round = 0; round < maxRounds; round++) {
    const resp = await deps.gateway.chat({ messages, tools: schemas });
    usage = { input: usage.input + resp.usage.input, output: usage.output + resp.usage.output };

    if (resp.content) {
      yield step('think', { text: resp.content });
      messages.push({ role: 'assistant', content: resp.content });
    }
    if (resp.toolCalls.length === 0) break;

    for (const call of resp.toolCalls) {
      yield step('tool_call', { tool: call.name, args: call.args });
      const tool = deps.tools.find((t) => t.name === call.name);
      let ok = true;
      let result: unknown;
      try {
        if (!tool) throw new Error(`unknown_tool:${call.name}`);
        result = await tool.execute(call.args);
      } catch (err) {
        ok = false;
        result = { error: String(err) };
      }
      yield step('tool_result', { tool: call.name, ok, preview: preview(result) });
      // 工具结果回填进对话，供下一轮模型使用（截断防上下文爆炸）。
      messages.push({ role: 'tool', content: JSON.stringify(result).slice(0, 4000) });
    }
  }

  deps.onUsage?.(usage);
}

function preview(value: unknown): unknown {
  const s = JSON.stringify(value);
  return s.length > 500 ? { truncated: true, text: s.slice(0, 500) } : value;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test agent-loop`
Expected: PASS（4 tests）。

- [ ] **Step 5: 删除 M0 的模拟实现**

```bash
git rm apps/agent-runtime/src/fake-agent.ts apps/agent-runtime/src/fake-agent.test.ts
```

- [ ] **Step 6: 改写 `apps/agent-runtime/src/server.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { encodeSse } from '@ai-office/shared';
import type { RunRequest } from '@ai-office/shared';
import { runAgent } from './agent-loop';
import { createGateway } from './model/create-gateway';
import type { ModelGateway } from './model/types';
import { createTools } from './tools/registry';
import type { Tool } from './tools/types';

export interface RuntimeDeps {
  gateway?: ModelGateway;
  tools?: Tool[];
}

export function createRuntimeServer(deps: RuntimeDeps = {}): Server {
  const gateway = deps.gateway ?? createGateway();
  const tools = deps.tools ?? createTools();

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/runs') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let runReq: RunRequest;
        try {
          runReq = JSON.parse(body || '{}') as RunRequest;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        void (async () => {
          try {
            for await (const ev of runAgent(runReq, {
              gateway,
              tools,
              onUsage: (u) => res.write(encodeSse({ event: 'usage', data: u })),
            })) {
              res.write(encodeSse({ event: 'step', data: ev }));
            }
            res.write(encodeSse({ event: 'done', data: { runId: runReq.runId } }));
          } catch (err) {
            res.write(encodeSse({ event: 'error', data: { message: String(err) } }));
          } finally {
            res.end();
          }
        })();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

const isEntry = !!process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const port = Number(process.env.PORT ?? 4001);
  createRuntimeServer().listen(port, () => {
    console.log(`agent-runtime listening on http://localhost:${port}`);
  });
}
```

- [ ] **Step 7: 改写 `apps/agent-runtime/src/server.test.ts`**

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { decodeSseFrames } from '@ai-office/shared';
import { createRuntimeServer } from './server';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';

const echo: Tool = {
  name: 'web.search',
  description: 'd',
  parameters: {},
  async execute() {
    return { results: [] };
  },
};

const scripted: ModelGateway = {
  async chat({ messages }) {
    const hasTool = messages.some((m) => m.role === 'tool');
    if (!hasTool) {
      return {
        content: '查一下',
        toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
        usage: { input: 1, output: 1 },
      };
    }
    return { content: '完成', toolCalls: [], usage: { input: 1, output: 1 } };
  },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createRuntimeServer({ gateway: scripted, tools: [echo] });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function postRuns(payload: unknown) {
  return fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('runtime server', () => {
  it('GET /health 返回 ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /runs 按序吐出 step 与 usage、done', async () => {
    const res = await postRuns({
      runId: 'r1',
      sessionId: 's1',
      goal: 'g',
      messages: [{ role: 'user', content: 'g' }],
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const messages = decodeSseFrames(await res.text());
    expect(messages.map((m) => m.event)).toEqual(['step', 'step', 'step', 'usage', 'step', 'done']);
  });

  it('非法 JSON 返回 400', async () => {
    const res = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('未知路由返回 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 8: 运行全部 runtime 测试 + 类型检查**

Run: `pnpm --filter @ai-office/agent-runtime test && pnpm --filter @ai-office/agent-runtime typecheck`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add apps/agent-runtime/src
git commit -m "feat(runtime): 真 Agent Loop 替换模拟循环，/prompt 改为 /runs"
```

---

## Task 8: `bff` —— tasks 模块（建 task/run、透传 SSE、写 step）

**Files:**
- Modify: `packages/shared/src/protocol.ts`（把有状态 SSE 解析器上移，web/bff 共用）
- Modify: `apps/bff/src/stream/stream.controller.ts` → 删除整个 `stream/` 目录
- Create: `apps/bff/src/stream/sse-proxy.ts`（从 M0 抽出的裸 socket 转发工具）
- Create: `apps/bff/src/tasks/tasks.service.ts`
- Create: `apps/bff/src/tasks/tasks.controller.ts`
- Test: `apps/bff/src/tasks/tasks.controller.test.ts`
- Modify: `apps/bff/src/app.module.ts`

- [ ] **Step 1: 在 `packages/shared/src/protocol.ts` 末尾追加有状态解析器**

```ts
/**
 * 有状态的 SSE 解析器：维护缓冲区，跨网络分片逐个产出完整事件。
 * 原为 web 独有；BFF 需要在转发时同步解析以落库，故上移共用。
 */
export function createSseParser(): (chunk: string) => SseMessage[] {
  let buffer = '';
  return function parse(chunk: string): SseMessage[] {
    buffer += chunk;
    const events: SseMessage[] = [];
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const msg = parseSseFrame(frame);
      if (msg) events.push(msg);
    }
    return events;
  };
}
```

- [ ] **Step 2: 构建 shared**

Run: `pnpm --filter @ai-office/shared build`
Expected: 成功。

- [ ] **Step 3: 删除被取代的 M0 stream 模块**

```bash
git rm apps/bff/src/stream/stream.controller.ts apps/bff/src/stream/stream.controller.test.ts
```

- [ ] **Step 3b: 删除已被 `RunRequest` 取代的 `PromptRequest`**

`PromptRequest`（`packages/shared/src/protocol.ts`）在 M0 只有已删除的 `stream.controller.ts` 使用；`RunRequest` 取代它后即成为孤儿，须一并删除，避免死类型留在公共导出面上。

在 `packages/shared/src/protocol.ts` 中删除这一段：

```ts
export interface PromptRequest {
  goal: string;
  sessionId?: string;
}
```

然后在仓库根确认无残留引用：

```bash
grep -rn "PromptRequest" --include=*.ts apps packages || echo "no refs"
```
Expected: 输出 `no refs`（或仅剩本计划/规格文档中的提及）。

- [ ] **Step 4: 创建 `apps/bff/src/stream/sse-proxy.ts`**

```ts
import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

/**
 * hijack 之后 Fastify 不再参与发送，中间件写进 reply 的响应头（CORS 等）也不会
 * 自动落到 socket 上。这里把已累积的回复头取出、与本次响应的头合并后显式写入。
 */
export function writeHead(
  reply: FastifyReply,
  status: number,
  headers: OutgoingHttpHeaders,
): void {
  const accumulated: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) accumulated[key] = value;
  }
  reply.raw.writeHead(status, { ...accumulated, ...headers });
}
```

- [ ] **Step 5: 创建 `apps/bff/src/tasks/tasks.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { AgentEvent, ChatMessage } from '@ai-office/shared';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** 建 task/run、落用户消息，并回传喂给模型的完整历史。 */
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
  ): Promise<{ taskId: string; runId: string; messages: ChatMessage[] }> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);

    const prior = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    const task = await this.prisma.task.create({
      data: { sessionId, goal, status: 'running' },
    });
    const run = await this.prisma.run.create({
      data: { taskId: task.id, status: 'running' },
    });
    await this.prisma.message.create({
      data: { sessionId, role: 'user', content: goal, seq: prior.length },
    });

    const messages: ChatMessage[] = [
      ...prior.map((m) => ({ role: m.role as ChatMessage['role'], content: m.content })),
      { role: 'user', content: goal },
    ];
    return { taskId: task.id, runId: run.id, messages };
  }

  async recordStep(runId: string, ev: AgentEvent): Promise<void> {
    await this.prisma.step.create({
      data: { runId, seq: ev.seq, type: ev.type, payload: ev.payload as unknown as Prisma.InputJsonValue },
    });
  }

  async finish(
    runId: string,
    taskId: string,
    status: 'done' | 'failed',
    assistantText: string,
    sessionId: string,
  ): Promise<void> {
    await this.prisma.run.update({ where: { id: runId }, data: { status, endedAt: new Date() } });
    await this.prisma.task.update({ where: { id: taskId }, data: { status } });
    if (assistantText) {
      const count = await this.prisma.message.count({ where: { sessionId } });
      await this.prisma.message.create({
        data: { sessionId, role: 'assistant', content: assistantText, seq: count },
      });
    }
  }
}
```

- [ ] **Step 6: 创建 `apps/bff/src/tasks/tasks.controller.ts`**

```ts
import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createSseParser, type AgentEvent } from '@ai-office/shared';
import type { CreateTaskRequest } from '@ai-office/shared';
import { TasksService } from './tasks.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { writeHead } from '../stream/sse-proxy';

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post(':id/tasks')
  async run(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: CreateTaskRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // 接管回复：本方法直接写 reply.raw，必须 hijack，否则 Nest/Fastify 会再自动发一次响应。
    reply.hijack();

    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const goal = body?.goal ?? '';
    const { taskId, runId, messages } = await this.tasks.prepare(
      sessionId,
      user.tenantId,
      user.sub,
      goal,
    );

    let upstream: Response;
    try {
      upstream = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, sessionId, goal, messages }),
      });
    } catch {
      // 传输层失败：上游不可达，回 502 而不是未捕获的 500。
      await this.tasks.finish(runId, taskId, 'failed', '', sessionId);
      writeHead(reply, 502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
      return;
    }

    if (!upstream.ok || !upstream.body) {
      // 上游非 2xx：原样转发真实状态码与响应体，不伪装成 200 text/event-stream。
      await this.tasks.finish(runId, taskId, 'failed', '', sessionId);
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      writeHead(reply, upstream.status, { 'content-type': contentType });
      reply.raw.end(await upstream.text());
      return;
    }

    writeHead(reply, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const parse = createSseParser();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const thinkTexts: string[] = [];
    let status: 'done' | 'failed' = 'done';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        reply.raw.write(chunk);
        for (const m of parse(chunk)) {
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            if (ev.type === 'think') thinkTexts.push(String(ev.payload.text ?? ''));
            await this.tasks.recordStep(runId, ev);
          } else if (m.event === 'error') {
            status = 'failed';
          }
        }
      }
    } finally {
      await this.tasks.finish(runId, taskId, status, thinkTexts.join('\n'), sessionId);
      reply.raw.end();
    }
  }
}
```

- [ ] **Step 7: 修改 `apps/bff/src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './db/prisma.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController, SessionsController, TasksController],
  providers: [AuthService, SessionsService, TasksService],
})
export class AppModule {}
```

- [ ] **Step 8: 写测试 `apps/bff/src/tasks/tasks.controller.test.ts`**

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, type Server } from 'node:http';
import { encodeSse } from '@ai-office/shared';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

let upstream: Server;
let app: NestFastifyApplication;
let baseUrl: string;
const stored: { steps: unknown[]; messages: unknown[] } = { steps: [], messages: [] };

const session = { id: 's1', tenantId: 't1', userId: 'u1', title: 'x', createdAt: new Date() };

const fakePrisma = {
  session: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
      where.id === session.id && where.tenantId === session.tenantId && where.userId === session.userId
        ? session
        : null,
  },
  message: {
    findMany: async () => [],
    count: async () => 1,
    create: async ({ data }: { data: unknown }) => {
      stored.messages.push(data);
      return data;
    },
  },
  task: { create: async ({ data }: { data: unknown }) => ({ id: 'task1', ...(data as object) }), update: async () => ({}) },
  run: { create: async ({ data }: { data: unknown }) => ({ id: 'run1', ...(data as object) }), update: async () => ({}) },
  step: {
    create: async ({ data }: { data: unknown }) => {
      stored.steps.push(data);
      return data;
    },
  },
} as unknown as PrismaService;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';

  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSse({ event: 'step', data: { runId: 'run1', seq: 0, type: 'think', payload: { text: '想' }, ts: 1 } }));
    res.write(encodeSse({ event: 'step', data: { runId: 'run1', seq: 1, type: 'tool_call', payload: { tool: 'web.search' }, ts: 2 } }));
    res.write(encodeSse({ event: 'usage', data: { input: 1, output: 1 } }));
    res.write(encodeSse({ event: 'done', data: { runId: 'run1' } }));
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${addr.port}`;

  const moduleRef = await Test.createTestingModule({
    controllers: [SessionsController, TasksController],
    providers: [
      SessionsService,
      TasksService,
      { provide: PrismaService, useValue: fakePrisma },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('TasksController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/tasks',
      payload: { goal: 'g' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('透传 SSE 且把 step 落库', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '查竞品' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: step');
    expect(text).toContain('event: done');
    // usage 透传但不落库
    expect(stored.steps).toHaveLength(2);
  });
});
```

- [ ] **Step 9: 运行 bff 测试 + 类型检查**

Run: `pnpm --filter @ai-office/bff test && pnpm --filter @ai-office/bff typecheck`
Expected: PASS。注意 AGENT_RUNTIME_URL 若为真实 env，请用 `AGENT_RUNTIME_URL=` 覆盖。

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/protocol.ts apps/bff/src
git commit -m "feat(bff): 任务模块——建 task/run、透传 SSE 并落库 step"
```

---

## Task 9: `web` —— 登录页 + 工作台改造

**Files:**
- Modify: `apps/web/src/lib/sse-parser.ts`（改为复用 shared）
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/render-step.ts`
- Test: `apps/web/src/lib/render-step.test.ts`
- Create: `apps/web/src/app/login/page.tsx`
- Modify: `apps/web/src/app/page.tsx`

- [ ] **Step 1: 让 `apps/web/src/lib/sse-parser.ts` 复用 shared**

```ts
export { createSseParser } from '@ai-office/shared';
```

> 现存的 `sse-parser.test.ts` 无需改动，导入路径不变，仍应通过。

- [ ] **Step 2: 写失败测试 `apps/web/src/lib/render-step.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { renderStep } from './render-step';
import type { AgentEvent } from '@ai-office/shared';

const ev = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
  runId: 'r',
  seq: 0,
  type,
  payload,
  ts: 0,
});

describe('renderStep', () => {
  it('think 展示文本', () => {
    expect(renderStep(ev('think', { text: '思考中' }))).toBe('思考：思考中');
  });
  it('tool_call 展示工具名与参数', () => {
    expect(renderStep(ev('tool_call', { tool: 'web.search', args: { query: 'x' } }))).toContain(
      'web.search',
    );
  });
  it('tool_result 成功/失败文案不同', () => {
    expect(renderStep(ev('tool_result', { tool: 'web.search', ok: true }))).toContain('成功');
    expect(renderStep(ev('tool_result', { tool: 'web.search', ok: false }))).toContain('失败');
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/web test render-step`
Expected: FAIL —— `Cannot find module './render-step'`。

- [ ] **Step 4: 创建 `apps/web/src/lib/render-step.ts`**

```ts
import type { AgentEvent } from '@ai-office/shared';

/** 把一条 AgentEvent 渲染成人类可读文本（M1 的展示规则，集中一处便于测试）。 */
export function renderStep(ev: AgentEvent): string {
  switch (ev.type) {
    case 'think':
      return `思考：${String(ev.payload.text ?? '')}`;
    case 'tool_call':
      return `调用工具 ${String(ev.payload.tool)}（${JSON.stringify(ev.payload.args ?? {})}）`;
    case 'tool_result':
      return `工具 ${String(ev.payload.tool)} ${ev.payload.ok ? '成功' : '失败'}`;
    case 'artifact':
      return `产出：${JSON.stringify(ev.payload)}`;
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/web test render-step`
Expected: PASS（3 tests）。

- [ ] **Step 6: 创建 `apps/web/src/lib/api.ts`**

```ts
'use client';

import type { AuthResponse, SessionSummary } from '@ai-office/shared';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'ai_office_token';

export function getToken(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  return fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BFF_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`register_failed_${res.status}`);
  const data = (await res.json()) as AuthResponse;
  setToken(data.token);
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BFF_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login_failed_${res.status}`);
  const data = (await res.json()) as AuthResponse;
  setToken(data.token);
  return data;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await authFetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions_failed_${res.status}`);
  return (await res.json()) as SessionSummary[];
}

export async function createSession(): Promise<SessionSummary> {
  const res = await authFetch('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`create_session_failed_${res.status}`);
  return (await res.json()) as SessionSummary;
}

export async function streamTask(sessionId: string, goal: string): Promise<Response> {
  return authFetch(`/api/sessions/${sessionId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ goal }),
  });
}
```

- [ ] **Step 7: 创建 `apps/web/src/app/login/page.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, register } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
      router.push('/');
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <main>
      <h1>{mode === 'login' ? '登录' : '注册'}</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 }}>
        <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} style={{ padding: 8 }} />
        <input
          placeholder="密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 8 }}
        />
        <button type="submit" style={{ padding: 8 }}>{mode === 'login' ? '登录' : '注册'}</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <button
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        style={{ marginTop: 8, background: 'none', border: 'none', color: 'blue', cursor: 'pointer' }}
      >
        {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
      </button>
    </main>
  );
}
```

- [ ] **Step 8: 改写 `apps/web/src/app/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, SessionSummary } from '@ai-office/shared';
import { createSseParser } from '../lib/sse-parser';
import { clearToken, createSession, getToken, listSessions, streamTask } from '../lib/api';
import { renderStep } from '../lib/render-step';

export default function Home() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [goal, setGoal] = useState('调研竞品并给出结论');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
  }, [router]);

  async function refresh() {
    try {
      const list = await listSessions();
      setSessions(list);
      if (list.length) setSessionId(list[0].id);
    } catch (err) {
      setError(String(err));
    }
  }

  async function newSession() {
    const s = await createSession();
    setSessions((prev) => [s, ...prev]);
    setSessionId(s.id);
  }

  async function run() {
    if (!sessionId) await newSession();
    setEvents([]);
    setRunning(true);
    setError('');
    try {
      const res = await streamTask(sessionId, goal);
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parse(decoder.decode(value, { stream: true }))) {
          if (m.event === 'step') setEvents((prev) => [...prev, m.data as AgentEvent]);
          if (m.event === 'error') setError(JSON.stringify(m.data));
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <h1>AI 办公智能体 · M1 工作台</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ padding: 8 }}>
          <option value="">（新会话）</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <button onClick={newSession}>新建会话</button>
        <button
          onClick={() => { clearToken(); router.push('/login'); }}
          style={{ marginLeft: 'auto' }}
        >
          退出
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} style={{ flex: 1, padding: 8 }} />
        <button onClick={run} disabled={running}>{running ? '执行中…' : '开始'}</button>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <ol>
        {events.map((ev) => (
          <li key={ev.seq}>{renderStep(ev)}</li>
        ))}
      </ol>
    </main>
  );
}
```

- [ ] **Step 9: 运行测试 + 构建**

Run: `pnpm --filter @ai-office/web test && pnpm --filter @ai-office/web build`
Expected: 测试 PASS；Next.js 构建成功。

- [ ] **Step 10: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 登录页与 M1 工作台（带 JWT 调任务接口）"
```

---

## Task 10: 端到端联调 + 配置样例 + README

**Files:**
- Create: `.env.example`
- Modify: `turbo.json`（透传新 env）
- Modify: `README.md`
- Create: `.env`（本地，**不入库**；填入真实 key）

- [ ] **Step 1: 创建 `.env.example`**

```
DATABASE_URL=postgresql://ai_office:ai_office@localhost:5432/ai_office?schema=public
JWT_SECRET=change-me
DEEPSEEK_API_KEY=
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_NAME=deepseek-chat
TAVILY_API_KEY=
AGENT_RUNTIME_URL=http://localhost:4001
NEXT_PUBLIC_BFF_URL=http://localhost:4000
PORT=4000
```

- [ ] **Step 2: 修改 `turbo.json` 的 `globalPassThroughEnv`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalPassThroughEnv": [
    "PORT",
    "AGENT_RUNTIME_URL",
    "NEXT_PUBLIC_BFF_URL",
    "DATABASE_URL",
    "JWT_SECRET",
    "DEEPSEEK_API_KEY",
    "MODEL_BASE_URL",
    "MODEL_NAME",
    "TAVILY_API_KEY"
  ],
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 3: 创建本地 `.env`（不入库）**

在仓库根创建 `.env`，内容同 `.env.example`，并把 `DEEPSEEK_API_KEY` 填成真实 key。
Run: `git check-ignore .env`
Expected: 输出 `.env`（确认被忽略）。

- [ ] **Step 4: 起库并建表**

```bash
pnpm --filter @ai-office/bff db:up
pnpm --filter @ai-office/bff db:generate
pnpm --filter @ai-office/bff db:push
```
Expected: PG 容器起来；Prisma client 生成；表同步完成。

- [ ] **Step 5: 启动三端**

```bash
pnpm --filter @ai-office/agent-runtime dev   # 终端 1 → :4001
pnpm --filter @ai-office/bff dev             # 终端 2 → :4000
pnpm --filter @ai-office/web dev             # 终端 3 → :3000
```

- [ ] **Step 6: 命令行验证管道（旁证）**

```bash
# 1) 注册拿 token
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"demo@b.com","password":"pw123456"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")

# 2) 建会话
SID=$(curl -s -X POST http://localhost:4000/api/sessions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")

# 3) 下达目标，观察 SSE
curl -N -X POST "http://localhost:4000/api/sessions/$SID/tasks" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"调研竞品并给出结论"}'
```
Expected: 持续输出 `event: step`（think → tool_call → tool_result → …），随后 `event: usage`、`event: done`。
若 `DEEPSEEK_API_KEY` 已填，tool_call 的 `web.search` 会返回真实结果；否则走 MockGateway，仍是完整链路。

- [ ] **Step 7: 浏览器验证**

打开 `http://localhost:3000` → 跳转 `/login` → 注册 → 回工作台 → 输入目标 → 开始。
Expected: 工作台按 `思考/调用工具/工具结果` 逐条渲染。

- [ ] **Step 8: 更新 `README.md`**

在「## 开发」段落后追加：

```markdown
## 本地配置

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY（缺省时 Agent 走确定性 Mock，链路仍可验证）
pnpm --filter @ai-office/bff db:up      # 起 Postgres
pnpm --filter @ai-office/bff db:push    # 同步表结构
```

## M1 已具备

- 账号：邮箱+密码注册登录，JWT 鉴权
- 会话：多会话、消息历史持久化（Postgres + Prisma）
- Agent：真模型驱动的 Agent Loop（plan→act→observe），内置 `web.search` / `web.fetch`
```

- [ ] **Step 9: 全量测试与构建**

Run: `pnpm test && pnpm build`
Expected: 全绿。

- [ ] **Step 10: Commit**

```bash
git add .env.example turbo.json README.md
git commit -m "docs: 补 M1 配置样例与联调说明"
```

---

## 自审记录

**规格覆盖（对照 spec 各节）：**
- §2 决策 1/2（DeepSeek + 薄网关）→ Task 5
- §2 决策 3（邮箱+密码+JWT）→ Task 3
- §2 决策 4（Postgres+Prisma）→ Task 2
- §2 决策 6（联网工具）→ Task 6
- §4 数据模型 → Task 2（7 张表齐全）
- §5 协议（web↔bff、bff↔runtime 的 `/runs`）→ Task 8 / Task 7
- §6 Agent Loop 与网关 → Task 5 / Task 7
- §7 工具系统 → Task 6
- §8 数据流 → Task 8 / Task 9 串联
- §9 错误处理（401/403、502、工具失败不中断、上游非 2xx 透传）→ Task 3 / Task 6 / Task 7 / Task 8
- §10 非功能（argon2、JWT_SECRET、tenant 隔离、.env）→ Task 2 / Task 3 / Task 4 / Task 10
- §11 测试策略 → 各任务内嵌测试；M0 既有测试在 Task 7、Task 8 一并改写/删除

**占位符扫描：** 无 TBD/TODO；所有代码步骤均含完整代码。

**类型一致性：**
- `RunRequest` / `ChatMessage` / `AgentEvent` 在 Task 1 定义，Task 5/7/8 使用一致。
- `ModelGateway.chat(req: ChatRequest)` 在 Task 5 定义，Task 7 的 `RunDeps.gateway` 使用一致。
- `Tool` 接口在 Task 6 定义，Task 7 的 `RunDeps.tools` 与 registry 输出一致。
- `createSseParser` 在 Task 8 上移到 shared，Task 9 复用；web 的既有测试导入路径不变。
- `writeHead` 在 Task 8 从 M0 原样抽出，行为与 M0 测试一致（CORS 头合并）。

**已知取舍（评审可再议）：**
- BFF 的测试用**内存假 Prisma**（不依赖 Docker/真库），因此 `pnpm test` 无需起 PG；真实 PG 行为由 Task 10 的联调覆盖。
- DuckDuckGo 走 instant-answer 接口，结果质量有限；有 `TAVILY_API_KEY` 时自动切 Tavily。
- `stream/` 目录仅保留 `sse-proxy.ts`，其余删除。
