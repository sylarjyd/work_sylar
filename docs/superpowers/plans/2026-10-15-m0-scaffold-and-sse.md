# M0：三层骨架与 SSE 端到端打通 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 `web → bff → agent-runtime` 三层骨架，并证明一张 SSE 事件流能从 Agent 运行时穿透 BFF 抵达网页端实时渲染。

**Architecture:** pnpm monorepo + Turborepo，四个包：`packages/shared`（协议类型与编解码）、`apps/agent-runtime`（Node 原生 http，模拟 Agent Loop 产出事件流）、`apps/bff`（NestJS + Fastify，代理 SSE）、`apps/web`（Next.js App Router，消费并渲染流）。M0 不接数据库/Redis/模型，只验证管道。

**Tech Stack:** Node 22+ / TypeScript 5.6 / pnpm workspace / Turborepo / vitest / NestJS 10 (Fastify) / Next.js 15 (React 19) / tsx / tsup

**前置：** 仓库已 `git init`（见 `docs/superpowers/specs/2026-10-15-ai-office-agent-design.md` 的提交）。工作目录 `D:\ws\ai\agent\work_sylar`。所有命令用 bash（Windows 下 Git Bash）。

---

### Task 1: Monorepo 工作区脚手架

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.npmrc`
- Modify: `.gitignore`

- [ ] **Step 1: 创建 `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: 创建根 `package.json`**

```json
{
  "name": "ai-office",
  "private": true,
  "packageManager": "pnpm@10.19.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "test": "turbo run test"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "@swc/core", "sharp", "unrs-resolver"]
  },
  "devDependencies": {
    "turbo": "^2.3.3",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

> `packageManager` 与 `pnpm.onlyBuiltDependencies` 需匹配本机 **pnpm 10.x**：pnpm 10 默认不运行依赖的构建脚本，若不显式放行 `esbuild`/`@swc/core` 等，`vitest` 与 `next` 会安装后无法运行。

- [ ] **Step 3: 创建 `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 4: 创建 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  }
}
```

- [ ] **Step 5: 创建 `.npmrc` 与更新 `.gitignore`**

`.npmrc`：
```
auto-install-peers=true
strict-peer-dependencies=false
```

`.gitignore` 追加（保留已有内容）：
```
node_modules/
.next/
dist/
.turbo/
```

- [ ] **Step 6: 安装并验证**

Run: `pnpm install`
Expected: 生成 `pnpm-lock.yaml`，无报错。

Run: `pnpm exec turbo --version`
Expected: 打印 `2.x.x`。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc .gitignore pnpm-lock.yaml
git commit -m "chore: 初始化 monorepo 工作区脚手架"
```

---

### Task 2: `shared` 包 —— 协议类型与 SSE 编解码

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/protocol.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/protocol.test.ts`

- [ ] **Step 1: 创建 `packages/shared/package.json`**

```json
{
  "name": "@ai-office/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "dev": "tsup src/index.ts --format esm --dts --watch",
    "test": "vitest run"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: 写失败测试 `packages/shared/src/protocol.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { encodeSse, decodeSseFrames } from './protocol';

describe('encodeSse', () => {
  it('编码为合法的 SSE 帧', () => {
    expect(encodeSse({ event: 'step', data: { a: 1 } })).toBe(
      'event: step\ndata: {"a":1}\n\n',
    );
  });
});

describe('decodeSseFrames', () => {
  it('解析一个完整帧', () => {
    const out = decodeSseFrames(encodeSse({ event: 'done', data: { runId: 'r1' } }));
    expect(out).toEqual([{ event: 'done', data: { runId: 'r1' } }]);
  });

  it('解析连续两个完整帧', () => {
    const text =
      encodeSse({ event: 'step', data: { seq: 0 } }) +
      encodeSse({ event: 'done', data: { runId: 'r1' } });
    expect(decodeSseFrames(text)).toEqual([
      { event: 'step', data: { seq: 0 } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
  });

  it('尾部的半截帧被忽略，不抛异常', () => {
    const text =
      encodeSse({ event: 'step', data: { seq: 0 } }) + 'event: step\ndata: {"seq":';
    expect(decodeSseFrames(text)).toEqual([{ event: 'step', data: { seq: 0 } }]);
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/shared test`
Expected: FAIL —— `Cannot find module './protocol'`（文件尚未创建）。

- [ ] **Step 5: 写实现 `packages/shared/src/protocol.ts`**

```ts
export const SSE_EVENT_NAMES = ['step', 'usage', 'done', 'error'] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

export type StepType = 'think' | 'tool_call' | 'tool_result' | 'artifact';

export interface AgentEvent {
  runId: string;
  seq: number;
  type: StepType;
  payload: Record<string, unknown>;
  ts: number;
}

export interface PromptRequest {
  goal: string;
  sessionId?: string;
}

export interface SseMessage<T = unknown> {
  event: SseEventName;
  data: T;
}

/** 把一条消息编码为 SSE 帧（\n\n 结尾）。 */
export function encodeSse<T>(msg: SseMessage<T>): string {
  return `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
}

/** 解析单个完整帧；空帧或不合法帧返回 null。 */
export function parseSseFrame(frame: string): SseMessage | null {
  if (frame.trim() === '') return null;
  let event: string | undefined;
  let dataLine: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim();
  }
  if (!event || dataLine === undefined) return null;
  return { event: event as SseEventName, data: JSON.parse(dataLine) };
}

/**
 * 从一段**已累积**的文本中解析出所有完整 SSE 帧。
 * 末尾未以 \n\n 终止的残段被丢弃（视为尚未收完，等待后续分片）。
 */
export function decodeSseFrames(text: string): SseMessage[] {
  const segments = text.split('\n\n');
  if (!text.endsWith('\n\n')) segments.pop();
  return segments
    .map(parseSseFrame)
    .filter((m): m is SseMessage => m !== null);
}
```

> `decodeSseFrames` 只解析**完整帧**（以 `\n\n` 终止）；未终止的残段被丢弃，跨分片拼接交由调用方的缓冲区处理（见 Task 5 的 `createSseParser`）。

- [ ] **Step 6: 创建 `packages/shared/src/index.ts`**

```ts
export * from './protocol';
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/shared test`
Expected: PASS（3 个用例）。

- [ ] **Step 8: 构建并验证产物**

Run: `pnpm --filter @ai-office/shared build`
Expected: 生成 `packages/shared/dist/index.js` 与 `index.d.ts`。

- [ ] **Step 9: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): 协议类型与 SSE 编解码"
```

---

### Task 3: `agent-runtime` —— 模拟 Agent Loop 产出事件流

**Files:**
- Create: `apps/agent-runtime/package.json`
- Create: `apps/agent-runtime/tsconfig.json`
- Create: `apps/agent-runtime/src/fake-agent.ts`
- Create: `apps/agent-runtime/src/server.ts`
- Test: `apps/agent-runtime/src/fake-agent.test.ts`
- Test: `apps/agent-runtime/src/server.test.ts`

- [ ] **Step 1: 创建 `apps/agent-runtime/package.json`**

```json
{
  "name": "@ai-office/agent-runtime",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@ai-office/shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 `apps/agent-runtime/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: 写失败测试 `apps/agent-runtime/src/fake-agent.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { runFakeAgent } from './fake-agent';

describe('runFakeAgent', () => {
  it('按序产出 think→tool_call→tool_result→artifact，seq 从 0 递增', async () => {
    const events = [];
    for await (const ev of runFakeAgent('调研竞品', 'run-1')) events.push(ev);

    expect(events.map((e) => e.type)).toEqual([
      'think',
      'tool_call',
      'tool_result',
      'artifact',
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.every((e) => e.runId === 'run-1')).toBe(true);
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: FAIL —— `Cannot find module './fake-agent'`。

- [ ] **Step 5: 写实现 `apps/agent-runtime/src/fake-agent.ts`**

```ts
import type { AgentEvent, StepType } from '@ai-office/shared';

interface ScriptedStep {
  type: StepType;
  payload: Record<string, unknown>;
}

function buildScript(goal: string): ScriptedStep[] {
  return [
    { type: 'think', payload: { text: `规划：${goal}` } },
    { type: 'tool_call', payload: { tool: 'web.search', args: { q: goal } } },
    { type: 'tool_result', payload: { tool: 'web.search', ok: true } },
    { type: 'artifact', payload: { kind: 'pptx', name: `${goal}.pptx` } },
  ];
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 模拟 Agent Loop：按脚本逐步吐事件，每步之间有小延迟以模拟真实耗时。
 * M1 起将被真正的（模型驱动）循环替换。
 */
export async function* runFakeAgent(
  goal: string,
  runId: string,
): AsyncGenerator<AgentEvent> {
  const script = buildScript(goal);
  for (let seq = 0; seq < script.length; seq++) {
    const step = script[seq];
    await delay(50);
    yield { runId, seq, type: step.type, payload: step.payload, ts: Date.now() };
  }
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: PASS。

- [ ] **Step 7: 写失败测试 `apps/agent-runtime/src/server.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRuntimeServer } from './server';
import { decodeSseFrames, type SseMessage } from '@ai-office/shared';
import type { Server } from 'node:http';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createRuntimeServer();
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('agent-runtime server', () => {
  it('GET /health 返回 ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /prompt 返回 SSE 事件流并以 done 收尾', async () => {
    const res = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '写周报' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const messages: SseMessage[] = decodeSseFrames(text);
    expect(messages.map((m) => m.event)).toEqual([
      'step',
      'step',
      'step',
      'step',
      'done',
    ]);
  });
});
```

- [ ] **Step 8: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: FAIL —— `createRuntimeServer is not a function`。

- [ ] **Step 9: 写实现 `apps/agent-runtime/src/server.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { encodeSse } from '@ai-office/shared';
import { runFakeAgent } from './fake-agent';

export function createRuntimeServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/prompt') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let goal = '';
        try {
          goal = (JSON.parse(body || '{}') as { goal?: string }).goal ?? '';
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }

        const runId = randomUUID();
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        void (async () => {
          try {
            for await (const ev of runFakeAgent(goal, runId)) {
              res.write(encodeSse({ event: 'step', data: ev }));
            }
            res.write(encodeSse({ event: 'done', data: { runId } }));
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

const isEntry = process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (isEntry) {
  const port = Number(process.env.PORT ?? 4001);
  createRuntimeServer().listen(port, () => {
    console.log(`agent-runtime listening on http://localhost:${port}`);
  });
}
```

- [ ] **Step 10: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: PASS（3 个用例）。

- [ ] **Step 11: Commit**

```bash
git add apps/agent-runtime
git commit -m "feat(agent-runtime): 模拟 Agent Loop 与 SSE 服务"
```

---

### Task 4: `bff` —— NestJS(Fastify) 代理 SSE

**Files:**
- Create: `apps/bff/package.json`
- Create: `apps/bff/tsconfig.json`
- Create: `apps/bff/nest-cli.json`
- Create: `apps/bff/src/main.ts`
- Create: `apps/bff/src/app.module.ts`
- Create: `apps/bff/src/stream/stream.controller.ts`
- Test: `apps/bff/src/stream/stream.controller.test.ts`

- [ ] **Step 1: 创建 `apps/bff/package.json`**

```json
{
  "name": "@ai-office/bff",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.6",
    "@nestjs/core": "^10.4.6",
    "@nestjs/platform-fastify": "^10.4.6",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "@ai-office/shared": "workspace:*"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.7",
    "@nestjs/testing": "^10.4.6",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 `apps/bff/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2022"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 `apps/bff/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

- [ ] **Step 4: 写失败测试 `apps/bff/src/stream/stream.controller.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, type Server } from 'node:http';
import { AppModule } from '../app.module';
import { encodeSse, decodeSseFrames } from '@ai-office/shared';

let upstream: Server;
let upstreamUrl: string;
let app: NestFastifyApplication;

beforeAll(async () => {
  // 假的 agent-runtime：立刻返回两个 step + done
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSse({ event: 'step', data: { seq: 0, type: 'think' } }));
    res.write(encodeSse({ event: 'step', data: { seq: 1, type: 'artifact' } }));
    res.write(encodeSse({ event: 'done', data: { runId: 'r1' } }));
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  process.env.AGENT_RUNTIME_URL = upstreamUrl;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('StreamController', () => {
  it('POST /api/stream 透传上游 SSE 事件', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stream',
      payload: { goal: '写周报' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const messages = decodeSseFrames(res.payload);
    expect(messages.map((m) => m.event)).toEqual(['step', 'step', 'done']);
  });
});
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/bff test`
Expected: FAIL —— `Cannot find module '../app.module'`。

- [ ] **Step 6: 写实现 `apps/bff/src/stream/stream.controller.ts`**

```ts
import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { PromptRequest } from '@ai-office/shared';

const RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';

@Controller('api/stream')
export class StreamController {
  @Post()
  async stream(@Body() body: PromptRequest, @Res() reply: FastifyReply): Promise<void> {
    const upstream = await fetch(`${RUNTIME_URL}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: body.goal }),
    });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (!upstream.body) {
      reply.raw.end();
      return;
    }

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(Buffer.from(value));
      }
    } finally {
      reply.raw.end();
    }
  }
}
```

- [ ] **Step 7: 写实现 `apps/bff/src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { StreamController } from './stream/stream.controller';

@Module({ controllers: [StreamController] })
export class AppModule {}
```

- [ ] **Step 8: 写实现 `apps/bff/src/main.ts`**

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableCors({ origin: true });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`bff listening on http://localhost:${port}`);
}

void bootstrap();
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/bff test`
Expected: PASS。

- [ ] **Step 10: 构建验证**

Run: `pnpm --filter @ai-office/bff build`
Expected: 生成 `apps/bff/dist/main.js`，无类型错误。

- [ ] **Step 11: Commit**

```bash
git add apps/bff
git commit -m "feat(bff): NestJS(Fastify) 代理 Agent 事件流"
```

---

### Task 5: `web` —— Next.js 消费并渲染事件流

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.mjs`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/lib/sse-parser.ts`
- Test: `apps/web/src/lib/sse-parser.test.ts`

- [ ] **Step 1: 创建 `apps/web/package.json`**

```json
{
  "name": "@ai-office/web",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^15.1.5",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@ai-office/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "src", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: 创建 `apps/web/next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ai-office/shared'],
};

export default nextConfig;
```

- [ ] **Step 4: 写失败测试 `apps/web/src/lib/sse-parser.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createSseParser } from './sse-parser';

describe('createSseParser', () => {
  it('跨多个网络分片拼接并逐个产出事件', () => {
    const parse = createSseParser();

    // 分片 1：第一个帧完整；第二个帧被截断在 "data:" 之前
    expect(parse('event: step\ndata: {"seq":0}\n\nevent: step\nda')).toEqual([
      { event: 'step', data: { seq: 0 } },
    ]);
    // 分片 2：补完第二个帧
    expect(parse('ta: {"seq":1}\n\n')).toEqual([
      { event: 'step', data: { seq: 1 } },
    ]);
    // 分片 3：一个新帧
    expect(parse('event: done\ndata: {"runId":"r1"}\n\n')).toEqual([
      { event: 'done', data: { runId: 'r1' } },
    ]);
  });
});
```

> 说明：上面的分片切法故意制造了"半个 data 行落在分片边界"的情况。若 parser 未按行缓冲，测试会失败。

- [ ] **Step 5: 运行测试，确认失败**

Run: `pnpm --filter @ai-office/web test`
Expected: FAIL —— `Cannot find module './sse-parser'`。

- [ ] **Step 6: 写实现 `apps/web/src/lib/sse-parser.ts`**

```ts
import { parseSseFrame, type SseMessage } from '@ai-office/shared';

/**
 * 有状态的 SSE 解析器：维护缓冲区，跨网络分片逐个产出完整事件。
 * 复用 shared 的 parseSseFrame，避免重复解析逻辑。
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

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm --filter @ai-office/web test`
Expected: PASS。

- [ ] **Step 8: 创建 `apps/web/src/app/layout.tsx`**

```tsx
import type { ReactNode } from 'react';

export const metadata = { title: 'AI 办公智能体' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 24 }}>{children}</body>
    </html>
  );
}
```

- [ ] **Step 9: 创建 `apps/web/src/app/page.tsx`**

```tsx
'use client';

import { useState } from 'react';
import type { AgentEvent, SseMessage } from '@ai-office/shared';
import { createSseParser } from '../lib/sse-parser';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';

export default function Home() {
  const [goal, setGoal] = useState('调研竞品并生成一份 PPT');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setEvents([]);
    setRunning(true);
    try {
      const res = await fetch(`${BFF_URL}/api/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      if (!res.body) throw new Error('no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const messages: SseMessage[] = parse(decoder.decode(value, { stream: true }));
        for (const m of messages) {
          if (m.event === 'step') setEvents((prev) => [...prev, m.data as AgentEvent]);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <h1>AI 办公智能体 · M0 管道验证</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={run} disabled={running}>
          {running ? '执行中…' : '开始'}
        </button>
      </div>
      <ol>
        {events.map((ev) => (
          <li key={ev.seq}>
            <b>[{ev.type}]</b> {JSON.stringify(ev.payload)}
          </li>
        ))}
      </ol>
    </main>
  );
}
```

- [ ] **Step 10: 运行测试与类型检查**

Run: `pnpm --filter @ai-office/web test`
Expected: PASS。

Run: `pnpm --filter @ai-office/web build`
Expected: Next.js 构建成功。

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "feat(web): 消费并渲染 Agent 事件流"
```

---

### Task 6: 端到端联调验证

**Files:**
- Create: `README.md`

- [ ] **Step 1: 启动三端**

开三个终端分别运行（或在一个终端用 `pnpm dev`）：
```bash
pnpm --filter @ai-office/agent-runtime dev
pnpm --filter @ai-office/bff dev
pnpm --filter @ai-office/web dev
```

- [ ] **Step 2: 验证管道**

浏览器打开 `http://localhost:3000`，点击"开始"。
Expected：页面依次出现 `think → tool_call → tool_result → artifact` 四条事件（每条约 50ms 间隔）。

- [ ] **Step 3: 命令行旁证（可选）**

```bash
curl -N -X POST http://localhost:4000/api/stream \
  -H 'content-type: application/json' -d '{"goal":"hello"}'
```
Expected：持续输出 `event: step ...`，最后 `event: done`。

- [ ] **Step 4: 创建 `README.md`**

```markdown
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
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: 补充 README 开发说明"
```

---

## 自审记录

- **规格覆盖**：M0 对应设计文档 §3「三层解耦」与 §5.6「SSE 事件」；Task 2–5 逐层验证。M1–M5 不属本计划。
- **占位符扫描**：无 TBD/TODO；所有代码步骤均含完整代码。
- **类型一致性**：`AgentEvent` / `SseMessage` / `encodeSse` / `parseSseFrame` / `decodeSseFrames` 在 Task 2 定义，Task 3/4/5 使用一致；`createRuntimeServer` 在 Task 3 定义并被其测试使用；`createSseParser` 在 Task 5 定义、复用 `parseSseFrame`，并被其测试与页面使用。
- **解析边界修正**：`decodeSseFrames` 丢弃未以 `\n\n` 终止的残段（避免半截 JSON 抛异常）；`createSseParser` 按 `\n\n` 切分累积缓冲区（避免分片切点落在 `data:` 行中间导致丢帧）。
