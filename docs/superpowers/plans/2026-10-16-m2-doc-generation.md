# M2「会干活」· 文档生成与成果区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 能用 `doc.docx` / `doc.xlsx` / `doc.pptx` 三个工具生成文档、上传 MinIO，并在网页成果区列出与下载。

**Architecture:** 沿用 M1 三层解耦。runtime 工具生成字节后直传 MinIO（S3 兼容），并额外 `yield` 一条 `artifact` step；BFF 透传 SSE 时把 `artifact` step 落 `Artifact` 表，并提供租户校验的列表与下载代理；web 工作台内嵌成果区。工具契约扩展为 `execute(args, ctx)`，由 `agent-loop` 用当次运行的 `RunContext` 注入 `tenantId/sessionId/runId`（存储实例仍在启动期构建一次）。

**Tech Stack:** Node 22 + TypeScript + ESM；`@aws-sdk/client-s3`、`docx`、`exceljs`、`pptxgenjs`、`fflate`(dev)；NestJS 10 + Fastify + Prisma 6（BFF）；Next.js 15（web）；vitest；MinIO（docker）。

参考 spec：`docs/superpowers/specs/2026-10-16-m2-doc-generation-design.md`。

---

## 文件结构总览

**shared**
- 改 `packages/shared/src/dto.ts`：`RunRequest` 增 `tenantId`；新增 `ArtifactKind` / `ArtifactRef` / `ArtifactDto`。

**agent-runtime**（`apps/agent-runtime`）
- 改 `src/tools/types.ts`：新增 `RunContext`；`Tool.execute` 增 `ctx` 参数。
- 改 `src/agent-loop.ts`：构造 `RunContext` 并透传；工具结果含 `artifact` 时额外 `yield` 一条 `artifact` step。
- 新 `src/storage/s3.ts`：`createS3Client` / `createStorage`（`ensureBucket` / `putObject` / `getObjectStream`）。
- 新 `src/tools/doc-generators.ts`：`buildDocx` / `buildXlsx` / `buildPptx` 纯函数。
- 新 `src/tools/doc.ts`：`createDocTools(storage)` + `artifactKey` / `safeFilename`。
- 改 `src/tools/registry.ts`：`createTools(env, storage)` 追加三个 doc 工具。
- 改 `src/server.ts`：`RuntimeDeps.storage`；入口 `ensureBucket`（best-effort）。

**bff**（`apps/bff`）
- 改 `prisma/schema.prisma`：`Artifact` 模型 + `Session`/`Run` 反向关系。
- 新 `src/artifacts/storage.ts`：`ARTIFACT_STORAGE` token + `createArtifactStorage`。
- 新 `src/artifacts/artifacts.service.ts`：`record` / `list` / `getForDownload`。
- 新 `src/artifacts/artifacts.controller.ts`：列表 + 下载代理。
- 改 `src/app.module.ts`：注册 artifacts 三件套 + storage provider。
- 改 `src/tasks/tasks.service.ts`：`prepare` 回传 `tenantId`。
- 改 `src/tasks/tasks.controller.ts`：请求体带 `tenantId`；`artifact` step 落库（容错）。

**web**（`apps/web`）
- 改 `src/lib/api.ts`：`listArtifacts` / `downloadArtifact`。
- 改 `src/lib/render-step.ts`：`artifact` 分支改为人类可读文案。
- 改 `src/app/page.tsx`：成果区（卡片 + 下载）。

**infra**
- 改 `apps/bff/docker-compose.yml`：增 MinIO 服务。
- 改 `.env.example` / `turbo.json`：增 `S3_*`。

---

## Task 1: shared 契约 —— RunRequest.tenantId 与产物类型

**Files:**
- Modify: `packages/shared/src/dto.ts`

- [ ] **Step 1: 修改 `packages/shared/src/dto.ts`**

把 `RunRequest` 改为带 `tenantId`，并在文件末尾追加产物类型：

```ts
export interface RunRequest {
  runId: string;
  sessionId: string;
  /** 产物存储 Key 需按租户隔离；BFF 从 JWT 取出后透传给 runtime。 */
  tenantId: string;
  goal: string;
  messages: ChatMessage[];
}
```

在 `dto.ts` 末尾追加：

```ts
export type ArtifactKind = 'docx' | 'xlsx' | 'pptx';

/** 工具产出物的引用；`artifact` step 的 payload 即此类型。 */
export interface ArtifactRef {
  kind: ArtifactKind;
  filename: string;
  storageKey: string;
  size: number;
}

/** 成果区列表项。 */
export interface ArtifactDto {
  id: string;
  kind: ArtifactKind;
  filename: string;
  size: number;
  version: number;
  createdAt: string;
}
```

- [ ] **Step 2: 构建 shared 验证类型可编译**

Run: `pnpm --filter @ai-office/shared build`
Expected: 构建成功，无 TS 报错（`dist/` 产出 index.js / index.d.ts）。

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `pnpm test`
Expected: 全绿。此时 `agent-loop.test.ts` 的 `req` 仍缺 `tenantId`，但因 vitest 用 esbuild 只剥类型、不做类型检查，测试不会失败；Task 2 会补上该字段。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dto.ts
git commit -m "feat(shared): M2 契约补齐 tenantId 与产物类型

产物 Key 需按租户隔离，RunRequest 必须带上 tenantId；
同时把 artifact step 的 payload 定型为 ArtifactRef，供三层共用。"
```

---

## Task 2: runtime 工具契约 —— RunContext 与 execute(args, ctx)

**Files:**
- Modify: `apps/agent-runtime/src/tools/types.ts`
- Modify: `apps/agent-runtime/src/agent-loop.ts`
- Test: `apps/agent-runtime/src/agent-loop.test.ts`

- [ ] **Step 1: 写失败测试（在 `agent-loop.test.ts` 末尾 `describe` 内追加两条用例，并给 `req` 补 tenantId）**

先给 `req` 加 `tenantId`：

```ts
const req: RunRequest = {
  runId: 'r1',
  sessionId: 's1',
  tenantId: 't1',
  goal: '查竞品',
  messages: [{ role: 'user', content: '查竞品' }],
};
```

在 `describe('runAgent', ...)` 内追加：

```ts
  it('把运行上下文透传给工具 execute', async () => {
    let seen: unknown;
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '调用',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 } };
      },
    };
    const spyTool: Tool = {
      name: 'web.search',
      description: 'd',
      parameters: {},
      async execute(_args, ctx) {
        seen = ctx;
        return { results: [] };
      },
    };
    await collect(runAgent(req, { gateway, tools: [spyTool] }));
    expect(seen).toEqual({ tenantId: 't1', sessionId: 's1', runId: 'r1' });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- agent-loop`
Expected: FAIL —— `execute` 第二参数 `ctx` 为 `undefined`，断言 `seen` 等于 `{...}` 失败。

- [ ] **Step 3: 修改 `apps/agent-runtime/src/tools/types.ts`**

```ts
/** 单次运行的上下文：工具拼存储 Key 等运行态信息从 here 取，避免工具集在启动期固化单次运行数据。 */
export interface RunContext {
  tenantId: string;
  sessionId: string;
  runId: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON-Schema：直接喂给模型做 function-calling。 */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}
```

现有 `web-search.ts` / `web-fetch.ts` 的 `execute(args)` 因「少参数函数可赋给多参数签名」而无需改动，仍是合法的 `Tool`。

- [ ] **Step 4: 修改 `apps/agent-runtime/src/agent-loop.ts` 透传 ctx**

在 `messages` 定义之后新增 ctx 构造：

```ts
  const ctx: RunContext = {
    tenantId: req.tenantId,
    sessionId: req.sessionId,
    runId: req.runId,
  };
```

把工具调用行 `result = await tool.execute(call.args);` 改为：

```ts
        result = await tool.execute(call.args, ctx);
```

并在文件顶部把 `Tool` 的 import 补上 `RunContext`：

```ts
import type { RunContext, Tool } from './tools/types';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test -- agent-loop`
Expected: PASS（既有 5 条 + 新增 1 条）。

- [ ] **Step 6: Commit**

```bash
git add apps/agent-runtime/src/tools/types.ts apps/agent-runtime/src/agent-loop.ts apps/agent-runtime/src/agent-loop.test.ts
git commit -m "feat(runtime): 工具契约引入运行上下文 RunContext

文档工具需按 tenantId/runId 拼存储 Key，而工具集在启动期构建一次、
跨 run 共享，拿不到单次运行信息；改由 execute(args, ctx) 在调用时注入。"
```

---

## Task 3: 基础设施 —— MinIO 服务与 S3 配置项

**Files:**
- Modify: `apps/bff/docker-compose.yml`
- Modify: `.env.example`
- Modify: `turbo.json`

- [ ] **Step 1: 修改 `apps/bff/docker-compose.yml`**

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
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data
volumes:
  pgdata:
  minio-data:
```

- [ ] **Step 2: 在 `.env.example` 末尾追加**

```
# MinIO（S3 兼容）对象存储：runtime 写、bff 读，桶由 runtime 启动时幂等创建
S3_ENDPOINT=http://127.0.0.1:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=artifacts
```

- [ ] **Step 3: 在 `turbo.json` 的 `globalPassThroughEnv` 数组末尾补四个变量**

```json
    "S3_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET"
```

（注意：上一行 `"TAVILY_API_KEY"` 之后需补逗号。）

- [ ] **Step 4: 校验 compose 文件并启动 MinIO**

Run: `cd apps/bff && docker-compose config`
Expected: 打印解析后的 YAML，含 `minio` 服务，无报错。

Run: `cd apps/bff && docker-compose up -d minio`
Expected: `Container bff-minio-1  Started`（若本机只有独立 `docker-compose` 而无 `docker compose` 插件，用前者）。

- [ ] **Step 5: 验证 MinIO 健康**

Run: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9000/minio/health/live`
Expected: `200`

- [ ] **Step 6: Commit**

```bash
git add apps/bff/docker-compose.yml .env.example turbo.json
git commit -m "chore(infra): 增加 MinIO 服务与 S3 配置项

产物需落对象存储，且不与 BFF/runtime 的本地磁盘耦合，故选 S3 兼容的 MinIO；
桶由 runtime 启动时幂等创建，不额外引入初始化容器。"
```

---

## Task 4: runtime 存储封装 storage/s3.ts

**Files:**
- Create: `apps/agent-runtime/src/storage/s3.ts`
- Test: `apps/agent-runtime/src/storage/s3.test.ts`
- Modify: `apps/agent-runtime/package.json`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @ai-office/agent-runtime add @aws-sdk/client-s3`
Expected: `package.json` 的 `dependencies` 出现 `@aws-sdk/client-s3`。

- [ ] **Step 2: 写失败测试 `apps/agent-runtime/src/storage/s3.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { PutObjectCommand, HeadBucketCommand, CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createStorage, createS3Client, DEFAULT_BUCKET, type S3Sender } from './s3';

function fakeSender(opts: { headFails?: boolean } = {}) {
  const sent: unknown[] = [];
  const sender: S3Sender = {
    async send(command: unknown) {
      sent.push(command);
      if (command instanceof HeadBucketCommand) {
        if (opts.headFails) throw new Error('NoSuchBucket');
        return {};
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([Buffer.from('hello')]) };
      }
      return {};
    },
  };
  return { sender, sent };
}

describe('createS3Client', () => {
  it('强制 path-style 且使用传入端点', () => {
    const client = createS3Client({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
    });
    expect(client.config.forcePathStyle).toBe(true);
    expect(client.config.endpoint).toBeTruthy();
  });
});

describe('createStorage', () => {
  it('putObject 传对 Bucket/Key/ContentType/Body', async () => {
    const { sender, sent } = fakeSender();
    const storage = createStorage({ S3_BUCKET: 'mybucket' }, sender);
    await storage.putObject('artifacts/t1/r1/x.pptx', Buffer.from('bytes'), 'application/x-pptx');
    const cmd = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(cmd.input).toMatchObject({
      Bucket: 'mybucket',
      Key: 'artifacts/t1/r1/x.pptx',
      ContentType: 'application/x-pptx',
    });
  });

  it('bucket 默认取 artifacts', async () => {
    const { sender, sent } = fakeSender();
    const storage = createStorage({}, sender);
    await storage.putObject('k', Buffer.from('b'), 'text/plain');
    const cmd = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(cmd.input.Bucket).toBe(DEFAULT_BUCKET);
  });

  it('ensureBucket 在 HeadBucket 成功时不建桶', async () => {
    const { sender, sent } = fakeSender({ headFails: false });
    await createStorage({}, sender).ensureBucket();
    expect(sent.some((c) => c instanceof CreateBucketCommand)).toBe(false);
  });

  it('ensureBucket 在 HeadBucket 失败时补建桶', async () => {
    const { sender, sent } = fakeSender({ headFails: true });
    await createStorage({}, sender).ensureBucket();
    expect(sent.some((c) => c instanceof CreateBucketCommand)).toBe(true);
  });

  it('getObjectStream 返回可读流', async () => {
    const { sender } = fakeSender();
    const stream = await createStorage({}, sender).getObjectStream('k');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- storage/s3`
Expected: FAIL —— `Cannot find module './s3'`。

- [ ] **Step 4: 实现 `apps/agent-runtime/src/storage/s3.ts`**

```ts
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';

export const DEFAULT_BUCKET = 'artifacts';

/** 最小发送接口：生产为 S3Client，单测注入假实现。 */
export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

export interface Storage {
  ensureBucket(): Promise<void>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObjectStream(key: string): Promise<Readable>;
}

export function createS3Client(env: NodeJS.ProcessEnv = process.env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: env.S3_REGION ?? 'us-east-1',
    // MinIO 用 path-style（bucket 作路径段而非子域），否则 DNS 解析不到虚拟主机。
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_SECRET_KEY ?? '',
    },
  });
}

export function createStorage(
  env: NodeJS.ProcessEnv = process.env,
  client: S3Sender = createS3Client(env),
): Storage {
  const bucket = env.S3_BUCKET ?? DEFAULT_BUCKET;
  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async getObjectStream(key) {
      const res = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        Body?: unknown;
      };
      if (!res.Body) throw new Error('empty_body');
      return res.Body as Readable;
    },
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test -- storage/s3`
Expected: PASS（6 条）。

- [ ] **Step 6: Commit**

```bash
git add apps/agent-runtime/package.json apps/agent-runtime/src/storage/s3.ts apps/agent-runtime/src/storage/s3.test.ts pnpm-lock.yaml
git commit -m "feat(runtime): 封装 S3 对象存储

产物字节只落地一次，由 runtime 直传 MinIO；封装 putObject/getObjectStream，
并提供幂等 ensureBucket，免去额外的初始化容器。"
```

---

## Task 5: 文档生成纯函数（docx/xlsx/pptx）

**Files:**
- Create: `apps/agent-runtime/src/tools/doc-generators.ts`
- Test: `apps/agent-runtime/src/tools/doc-generators.test.ts`
- Modify: `apps/agent-runtime/package.json`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @ai-office/agent-runtime add docx exceljs pptxgenjs`
Run: `pnpm --filter @ai-office/agent-runtime add -D fflate`
Expected: 三个运行依赖与 `fflate`(dev) 进入 `package.json`。

- [ ] **Step 2: 写失败测试 `apps/agent-runtime/src/tools/doc-generators.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import ExcelJS from 'exceljs';
import { buildDocx, buildXlsx, buildPptx } from './doc-generators';

describe('buildDocx', () => {
  it('产出合法 docx 且含标题/小标题/段落文本', async () => {
    const buf = await buildDocx({
      title: '季度报告',
      sections: [{ heading: '概述', paragraphs: ['第一段'] }],
    });
    // docx 本质是 zip：解出 document.xml 断言文本确实写进去了（而非仅非空）。
    const files = unzipSync(new Uint8Array(buf));
    const xml = strFromU8(files['word/document.xml']);
    expect(xml).toContain('季度报告');
    expect(xml).toContain('概述');
    expect(xml).toContain('第一段');
  });
});

describe('buildXlsx', () => {
  it('产出的表格可被 exceljs 反解，表头与数据行正确', async () => {
    const buf = await buildXlsx({
      sheets: [{ name: 'S1', rows: [['名称', '数量'], ['A', 3]] }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('S1');
    expect(ws?.getCell('A1').value).toBe('名称');
    expect(ws?.getCell('B1').value).toBe('数量');
    expect(ws?.getCell('A2').value).toBe('A');
    expect(ws?.getCell('B2').value).toBe(3);
  });
});

describe('buildPptx', () => {
  it('产出合法 pptx 且首页含标题与要点文本', async () => {
    const buf = await buildPptx({ slides: [{ title: '封面', bullets: ['要点一'] }] });
    const files = unzipSync(new Uint8Array(buf));
    const xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('封面');
    expect(xml).toContain('要点一');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- doc-generators`
Expected: FAIL —— `Cannot find module './doc-generators'`。

- [ ] **Step 4: 实现 `apps/agent-runtime/src/tools/doc-generators.ts`**

```ts
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';

export interface DocxInput {
  title?: string;
  sections: { heading?: string; paragraphs: string[] }[];
}

export interface XlsxInput {
  sheets: { name: string; rows: (string | number)[][] }[];
}

export interface PptxInput {
  slides: { title?: string; bullets: string[] }[];
}

export async function buildDocx(input: DocxInput): Promise<Buffer> {
  const children: Paragraph[] = [];
  if (input.title) {
    children.push(new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }));
  }
  for (const section of input.sections) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const text of section.paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildXlsx(input: XlsxInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of input.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildPptx(input: PptxInput): Promise<Buffer> {
  const pptx = new PptxGenJS();
  for (const s of input.slides) {
    const slide = pptx.addSlide();
    if (s.title) {
      slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 24, bold: true });
    }
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
      { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 16 },
    );
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return out;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test -- doc-generators`
Expected: PASS（3 条）。

- [ ] **Step 6: Commit**

```bash
git add apps/agent-runtime/package.json apps/agent-runtime/src/tools/doc-generators.ts apps/agent-runtime/src/tools/doc-generators.test.ts pnpm-lock.yaml
git commit -m "feat(runtime): 增加文档生成纯函数

生成器只做「输入 JSON → Buffer」，与上传解耦，便于用反解字节的方式单测；
docx/pptx 走 zip 解包断言 XML 文本，xlsx 用 exceljs 回读断言单元格。"
```

---

## Task 6: doc.* 工具与工具集接线

**Files:**
- Create: `apps/agent-runtime/src/tools/doc.ts`
- Test: `apps/agent-runtime/src/tools/doc.test.ts`
- Modify: `apps/agent-runtime/src/tools/registry.ts`
- Modify: `apps/agent-runtime/src/tools/registry.test.ts`

- [ ] **Step 1: 写失败测试 `apps/agent-runtime/src/tools/doc.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createDocTools, artifactKey, safeFilename } from './doc';
import type { Storage } from '../storage/s3';
import type { RunContext } from './types';

const ctx: RunContext = { tenantId: 't1', sessionId: 's1', runId: 'r1' };

function fakeStorage(captured: { key: string; body: Buffer; contentType: string }[]): Storage {
  return {
    ensureBucket: async () => {},
    putObject: async (key, body, contentType) => {
      captured.push({ key, body, contentType });
    },
    getObjectStream: async () => {
      throw new Error('unused');
    },
  };
}

describe('artifactKey / safeFilename', () => {
  it('按 artifacts/{tenantId}/{runId}/{uuid}-{filename} 拼 Key', () => {
    const key = artifactKey(ctx, '报告.pptx');
    expect(key).toMatch(/^artifacts\/t1\/r1\/[0-9a-f-]{36}-报告\.pptx$/);
  });

  it('清洗路径穿越字符，避免越出租户前缀', () => {
    expect(safeFilename('../../etc/passwd')).not.toContain('..');
    expect(safeFilename('../../etc/passwd')).not.toContain('/');
    const key = artifactKey(ctx, '../../etc/passwd');
    expect(key.startsWith('artifacts/t1/r1/')).toBe(true);
    expect(key).not.toContain('..');
  });
});

describe('createDocTools', () => {
  it('暴露 doc.docx / doc.xlsx / doc.pptx 三个工具', () => {
    const tools = createDocTools(fakeStorage([]));
    expect(tools.map((t) => t.name)).toEqual(['doc.docx', 'doc.xlsx', 'doc.pptx']);
  });

  it('doc.pptx 生成、上传并返回 ArtifactRef', async () => {
    const captured: { key: string; body: Buffer; contentType: string }[] = [];
    const tools = createDocTools(fakeStorage(captured));
    const pptx = tools.find((t) => t.name === 'doc.pptx')!;
    const out = (await pptx.execute(
      { filename: '报告.pptx', slides: [{ title: '封面', bullets: ['要点'] }] },
      ctx,
    )) as { artifact: Record<string, unknown> };
    expect(out.artifact).toMatchObject({ kind: 'pptx', filename: '报告.pptx' });
    expect(String(out.artifact.storageKey)).toMatch(/^artifacts\/t1\/r1\/.+-报告\.pptx$/);
    expect(Number(out.artifact.size)).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].contentType).toContain('presentationml');
    expect(captured[0].body.length).toBeGreaterThan(0);
  });

  it('doc.docx 缺 filename 抛错（交由 agent-loop 记为工具失败）', async () => {
    const docx = createDocTools(fakeStorage([])).find((t) => t.name === 'doc.docx')!;
    await expect(docx.execute({ sections: [] }, ctx)).rejects.toThrow('missing_filename');
  });

  it('doc.xlsx 生成并上传', async () => {
    const captured: { key: string; body: Buffer; contentType: string }[] = [];
    const xlsx = createDocTools(fakeStorage(captured)).find((t) => t.name === 'doc.xlsx')!;
    const out = (await xlsx.execute(
      { filename: '表.xlsx', sheets: [{ name: 'S1', rows: [['a', 1]] }] },
      ctx,
    )) as { artifact: Record<string, unknown> };
    expect(out.artifact).toMatchObject({ kind: 'xlsx', filename: '表.xlsx' });
    expect(captured[0].contentType).toContain('spreadsheetml');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- tools/doc`
Expected: FAIL —— `Cannot find module './doc'`。

- [ ] **Step 3: 实现 `apps/agent-runtime/src/tools/doc.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ArtifactKind, ArtifactRef } from '@ai-office/shared';
import type { Storage } from '../storage/s3';
import type { RunContext, Tool } from './types';
import { buildDocx, buildXlsx, buildPptx } from './doc-generators';

const MIME: Record<ArtifactKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 去掉路径分隔符与 `..`，防止模型给的 filename 越出 `artifacts/{tenantId}/{runId}/` 前缀。 */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim();
  return cleaned || 'artifact';
}

export function artifactKey(ctx: Pick<RunContext, 'tenantId' | 'runId'>, filename: string): string {
  return `artifacts/${ctx.tenantId}/${ctx.runId}/${randomUUID()}-${safeFilename(filename)}`;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`missing_${key}`);
  return v;
}

async function emit(
  storage: Storage,
  ctx: RunContext,
  kind: ArtifactKind,
  filename: string,
  bytes: Buffer,
): Promise<{ artifact: ArtifactRef }> {
  const storageKey = artifactKey(ctx, filename);
  await storage.putObject(storageKey, bytes, MIME[kind]);
  return { artifact: { kind, filename, storageKey, size: bytes.length } };
}

export function createDocTools(storage: Storage): Tool[] {
  return [
    {
      name: 'doc.docx',
      description: '生成 Word 文档（.docx），返回产出物引用。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，如 报告.docx' },
          title: { type: 'string', description: '文档标题（可选）' },
          sections: {
            type: 'array',
            description: '章节列表',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['filename', 'sections'],
      },
      async execute(args, ctx) {
        const filename = str(args, 'filename');
        const sections = args.sections;
        if (!Array.isArray(sections)) throw new Error('missing_sections');
        const bytes = await buildDocx({
          title: typeof args.title === 'string' ? args.title : undefined,
          sections: sections as { heading?: string; paragraphs: string[] }[],
        });
        return emit(storage, ctx, 'docx', filename, bytes);
      },
    },
    {
      name: 'doc.xlsx',
      description: '生成 Excel 表格（.xlsx），返回产出物引用。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，如 数据.xlsx' },
          sheets: {
            type: 'array',
            description: '工作表列表',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array' } },
              },
              required: ['name', 'rows'],
            },
          },
        },
        required: ['filename', 'sheets'],
      },
      async execute(args, ctx) {
        const filename = str(args, 'filename');
        const sheets = args.sheets;
        if (!Array.isArray(sheets)) throw new Error('missing_sheets');
        const bytes = await buildXlsx({ sheets: sheets as { name: string; rows: (string | number)[][] }[] });
        return emit(storage, ctx, 'xlsx', filename, bytes);
      },
    },
    {
      name: 'doc.pptx',
      description: '生成 PowerPoint 演示文稿（.pptx），返回产出物引用。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，如 汇报.pptx' },
          slides: {
            type: 'array',
            description: '幻灯片列表',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['filename', 'slides'],
      },
      async execute(args, ctx) {
        const filename = str(args, 'filename');
        const slides = args.slides;
        if (!Array.isArray(slides)) throw new Error('missing_slides');
        const bytes = await buildPptx({ slides: slides as { title?: string; bullets: string[] }[] });
        return emit(storage, ctx, 'pptx', filename, bytes);
      },
    },
  ];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test -- tools/doc`
Expected: PASS（6 条）。

- [ ] **Step 5: 修改 `apps/agent-runtime/src/tools/registry.ts`**

```ts
import type { Tool } from './types';
import { createWebSearchTool, createSearchProvider } from './web-search';
import { createWebFetchTool } from './web-fetch';
import { createDocTools } from './doc';
import { createStorage, type Storage } from '../storage/s3';

/** 内置工具集：web.search / web.fetch + doc.docx / doc.xlsx / doc.pptx。 */
export function createTools(
  env: NodeJS.ProcessEnv = process.env,
  storage: Storage = createStorage(env),
): Tool[] {
  return [
    createWebSearchTool(createSearchProvider(env)),
    createWebFetchTool(),
    ...createDocTools(storage),
  ];
}
```

- [ ] **Step 6: 修改 `apps/agent-runtime/src/tools/registry.test.ts` 的期望工具名**

```ts
    expect(tools.map((t) => t.name)).toEqual([
      'web.search',
      'web.fetch',
      'doc.docx',
      'doc.xlsx',
      'doc.pptx',
    ]);
```

并把用例名与注释更新为「五个工具」。为避免真实网络，测试用 `createTools({})` 即可（`createStorage({})` 只构造客户端，不发请求）。

- [ ] **Step 7: 运行 runtime 全量测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: PASS（含 registry 与 doc 全部用例）。

- [ ] **Step 8: Commit**

```bash
git add apps/agent-runtime/src/tools/doc.ts apps/agent-runtime/src/tools/doc.test.ts apps/agent-runtime/src/tools/registry.ts apps/agent-runtime/src/tools/registry.test.ts
git commit -m "feat(runtime): 增加 doc.* 文档工具并接线到工具集

三个工具统一「生成字节 → 上传 → 返回 {artifact}」；filename 做路径穿越清洗，
Key 按 tenantId/runId 前缀隔离。"
```

---

## Task 7: agent-loop 识别产物并产出 artifact 事件

**Files:**
- Modify: `apps/agent-runtime/src/agent-loop.ts`
- Test: `apps/agent-runtime/src/agent-loop.test.ts`

- [ ] **Step 1: 写失败测试（追加到 `agent-loop.test.ts` 的 `describe` 内）**

```ts
  it('工具结果含 artifact 时额外产出一条 artifact step', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '生成',
            toolCalls: [{ id: 'c1', name: 'doc.pptx', args: { filename: 'a.pptx' } }],
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 0, output: 0 } };
      },
    };
    const docTool: Tool = {
      name: 'doc.pptx',
      description: 'd',
      parameters: {},
      async execute() {
        return { artifact: { kind: 'pptx', filename: 'a.pptx', storageKey: 'k', size: 3 } };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [docTool] }));
    expect(events.map((e) => e.type)).toEqual([
      'think',
      'tool_call',
      'tool_result',
      'artifact',
      'think',
    ]);
    const art = events.find((e) => e.type === 'artifact');
    expect(art?.payload).toMatchObject({ kind: 'pptx', filename: 'a.pptx', storageKey: 'k', size: 3 });
  });

  it('工具失败时即使结果里有 artifact 也不产出 artifact step', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '生成',
            toolCalls: [{ id: 'c1', name: 'doc.pptx', args: {} }],
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 } };
      },
    };
    const badTool: Tool = {
      name: 'doc.pptx',
      description: 'd',
      parameters: {},
      async execute() {
        throw new Error('upload_failed');
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [badTool] }));
    expect(events.some((e) => e.type === 'artifact')).toBe(false);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/agent-runtime test -- agent-loop`
Expected: FAIL —— 第一条事件序列缺少 `artifact`。

- [ ] **Step 3: 修改 `apps/agent-runtime/src/agent-loop.ts`**

在 `yield step('tool_result', ...)` 之后、`messages.push({ role: 'tool', ... })` 之前插入：

```ts
      // 工具产出物：除 tool_result 外再补一条 artifact step，供 BFF 落库、web 成果区即时渲染。
      const artifact = ok ? extractArtifact(result) : undefined;
      if (artifact) {
        yield step('artifact', artifact);
      }
```

在文件末尾（`preview` 之后）追加：

```ts
/** 工具返回 `{ artifact: ArtifactRef }` 时取出该引用；结构不符则视为无产物。 */
function extractArtifact(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const ref = (result as { artifact?: unknown }).artifact;
  if (ref === null || typeof ref !== 'object') return undefined;
  return ref as Record<string, unknown>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test -- agent-loop`
Expected: PASS（既有 + Task 2 的 ctx 用例 + 新增 2 条）。

- [ ] **Step 5: Commit**

```bash
git add apps/agent-runtime/src/agent-loop.ts apps/agent-runtime/src/agent-loop.test.ts
git commit -m "feat(runtime): agent-loop 识别产物并产出 artifact 事件

工具成功且结果含 artifact 字段时，在 tool_result 之后再发一条 artifact step；
失败不产出，避免把未落存储的引用广播出去。"
```

---

## Task 8: runtime 入口接线 ensureBucket

**Files:**
- Modify: `apps/agent-runtime/src/server.ts`
- Test: `apps/agent-runtime/src/server.test.ts`

- [ ] **Step 1: 在 `apps/agent-runtime/src/server.ts` 扩展依赖与入口**

顶部 import 增加：

```ts
import { createStorage, type Storage } from './storage/s3';
```

`RuntimeDeps` 增可选 `storage`：

```ts
export interface RuntimeDeps {
  gateway?: ModelGateway;
  tools?: Tool[];
  storage?: Storage;
}
```

`createRuntimeServer` 内工具构建改为复用同一 storage 实例：

```ts
  const gateway = deps.gateway ?? createGateway();
  const storage = deps.storage ?? createStorage();
  const tools = deps.tools ?? createTools(process.env, storage);
```

把 `isEntry` 块改为在启动前幂等建桶（失败只告警，不阻断启动——MinIO 未起时工具会在运行期自然报错）：

```ts
if (isEntry) {
  loadRootEnv();
  const storage = createStorage();
  try {
    await storage.ensureBucket();
  } catch (err) {
    console.warn(`ensureBucket 失败（文档工具将在运行期报错）: ${(err as Error).message}`);
  }
  // 独立端口变量：与 bff 的 PORT 分开，避免根 .env 里 PORT=4000 把 runtime 也顶到 4000。
  const port = Number(process.env.AGENT_RUNTIME_PORT ?? 4001);
  // 默认只绑本机：该端点无内置鉴权（仅有可选 token），暴露到网络等于开放一个无鉴权的模型入口。
  // 部署到网络时须显式设 AGENT_RUNTIME_HOST=0.0.0.0 并同时配置 AGENT_RUNTIME_TOKEN。
  const host = process.env.AGENT_RUNTIME_HOST ?? '127.0.0.1';
  createRuntimeServer({ storage }).listen(port, host, () => {
    console.log(`agent-runtime listening on http://${host}:${port}`);
  });
}
```

- [ ] **Step 2: 在 `apps/agent-runtime/src/server.test.ts` 追加一条用例**

在既有 `describe` 内追加（`createRuntimeServer` 注入假 storage + 假工具，断言不因 storage 缺省而崩）：

```ts
  it('注入 storage 时正常启动并透传工具（不触网）', async () => {
    const storage = {
      ensureBucket: async () => {},
      putObject: async () => {},
      getObjectStream: async () => {
        throw new Error('unused');
      },
    };
    const server = createRuntimeServer({
      gateway: {
        async chat() {
          return { content: 'hi', toolCalls: [], usage: { input: 0, output: 0 } };
        },
      },
      tools: [],
      storage,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r', sessionId: 's', tenantId: 't', goal: 'g', messages: [] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise<void>((r) => server.close(() => r()));
  });
```

若该测试文件未 import `createRuntimeServer`，在顶部补：`import { createRuntimeServer } from './server';`。

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter @ai-office/agent-runtime test`
Expected: PASS（全量）。

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter @ai-office/agent-runtime typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/agent-runtime/src/server.ts apps/agent-runtime/src/server.test.ts
git commit -m "feat(runtime): 启动时确保 MinIO bucket 存在

bucket 幂等创建放在入口、best-effort：MinIO 未起只告警不阻断启动，
文档工具会在实际调用时以工具失败的形式暴露，不拖垮其余能力。"
```

---

## Task 9: Prisma Artifact 模型

**Files:**
- Modify: `apps/bff/prisma/schema.prisma`

- [ ] **Step 1: 在 `Session` 模型补反向关系**

```prisma
  messages  Message[]
  tasks     Task[]
  artifacts Artifact[]
```

在 `Run` 模型补：

```prisma
  steps     Step[]
  artifacts Artifact[]
```

- [ ] **Step 2: 在文件末尾追加 `Artifact` 模型**

```prisma
model Artifact {
  id         String   @id @default(uuid())
  tenantId   String
  sessionId  String
  runId      String
  kind       String   // docx | xlsx | pptx
  filename   String
  storageKey String
  size       Int
  version    Int      @default(1)
  createdAt  DateTime @default(now())
  session    Session  @relation(fields: [sessionId], references: [id])
  run        Run      @relation(fields: [runId], references: [id])

  @@index([sessionId])
  @@index([tenantId])
}
```

- [ ] **Step 3: 推库并生成客户端**

先确保 Postgres 在跑：`cd apps/bff && docker-compose up -d postgres`
Run: `pnpm --filter @ai-office/bff db:push`
Expected: 输出 `The database is now in sync with your Prisma schema`，并触发 `prisma generate`。

（若 `docker compose` 插件缺失，用独立 `docker-compose` 起库；`db:push` 脚本内部只调 `prisma`，不受影响。）

- [ ] **Step 4: 类型检查确认客户端已含 Artifact**

Run: `pnpm --filter @ai-office/bff typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/bff/prisma/schema.prisma
git commit -m "feat(bff): 增加 Artifact 数据模型

产物元数据落 Postgres（字节在 MinIO）；version 按 (sessionId, filename) 递增，
同名重生成即升版，便于后续做版本列表。"
```

---

## Task 10: BFF 产物落库、列表与下载代理

**Files:**
- Modify: `apps/bff/package.json`
- Create: `apps/bff/src/artifacts/storage.ts`
- Create: `apps/bff/src/artifacts/artifacts.service.ts`
- Create: `apps/bff/src/artifacts/artifacts.controller.ts`
- Test: `apps/bff/src/artifacts/artifacts.service.test.ts`
- Test: `apps/bff/src/artifacts/artifacts.controller.test.ts`
- Modify: `apps/bff/src/app.module.ts`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @ai-office/bff add @aws-sdk/client-s3`
Expected: `apps/bff/package.json` 出现该依赖。

- [ ] **Step 2: 写失败测试 `apps/bff/src/artifacts/artifacts.service.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ArtifactService } from './artifacts.service';
import type { PrismaService } from '../db/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';
import type { ArtifactStorage } from './storage';
import type { ArtifactRef } from '@ai-office/shared';

const session = { id: 's1', tenantId: 't1', userId: 'u1' };

const rows: {
  id: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  kind: string;
  filename: string;
  storageKey: string;
  size: number;
  version: number;
  createdAt: Date;
}[] = [];

const fakePrisma = {
  artifact: {
    aggregate: async ({ where }: { where: { sessionId: string; filename: string } }) => {
      const versions = rows
        .filter((r) => r.sessionId === where.sessionId && r.filename === where.filename)
        .map((r) => r.version);
      return { _max: { version: versions.length ? Math.max(...versions) : null } };
    },
    create: async ({ data }: { data: typeof rows[number] }) => {
      const row = { id: `a${rows.length + 1}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    findMany: async ({ where }: { where: { sessionId: string; tenantId: string } }) =>
      rows
        .filter((r) => r.sessionId === where.sessionId && r.tenantId === where.tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
      rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
  },
} as unknown as PrismaService;

const fakeSessions = {
  assertOwned: async (sessionId: string, tenantId: string, userId: string) => {
    if (sessionId !== session.id || tenantId !== session.tenantId || userId !== session.userId) {
      throw new NotFoundException('session_not_found');
    }
  },
} as unknown as SessionsService;

const fakeStorage = {
  getObjectStream: async () => Readable.from([Buffer.from('bytes')]),
} as unknown as ArtifactStorage;

const ref: ArtifactRef = {
  kind: 'pptx',
  filename: '报告.pptx',
  storageKey: 'artifacts/t1/r1/x-报告.pptx',
  size: 12,
};

describe('ArtifactService', () => {
  let service: ArtifactService;

  beforeEach(() => {
    rows.length = 0;
    service = new ArtifactService(fakePrisma, fakeSessions, fakeStorage);
  });

  it('record 首次落库取 version=1', async () => {
    await service.record('r1', 's1', 't1', ref);
    expect(rows[0]).toMatchObject({ version: 1, filename: '报告.pptx', kind: 'pptx' });
  });

  it('同名重生成 version 递增', async () => {
    await service.record('r1', 's1', 't1', ref);
    await service.record('r2', 's1', 't1', ref);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it('list 先校验会话归属，越权抛 404', async () => {
    await expect(service.list('s1', 't2', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list 返回本会话产物', async () => {
    await service.record('r1', 's1', 't1', ref);
    const out = await service.list('s1', 't1', 'u1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filename: '报告.pptx', size: 12, version: 1 });
  });

  it('getForDownload 越租户抛 404（不泄露存在性）', async () => {
    await service.record('r1', 's1', 't1', ref);
    await expect(service.getForDownload('a1', 't9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getForDownload 返回文件名、类型与流', async () => {
    await service.record('r1', 's1', 't1', ref);
    const out = await service.getForDownload('a1', 't1');
    expect(out.filename).toBe('报告.pptx');
    expect(out.kind).toBe('pptx');
    const chunks: Buffer[] = [];
    for await (const c of out.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('bytes');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @ai-office/bff test -- artifacts.service`
Expected: FAIL —— `Cannot find module './artifacts.service'`。

- [ ] **Step 4: 实现 `apps/bff/src/artifacts/storage.ts`**

```ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/** Nest 注入令牌：BFF 侧只读（下载代理），与 runtime 的写侧各自实例化。 */
export const ARTIFACT_STORAGE = 'ARTIFACT_STORAGE';

export interface ArtifactStorage {
  getObjectStream(key: string): Promise<Readable>;
}

export function createArtifactStorage(env: NodeJS.ProcessEnv = process.env): ArtifactStorage {
  const bucket = env.S3_BUCKET ?? 'artifacts';
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_SECRET_KEY ?? '',
    },
  });
  return {
    async getObjectStream(key) {
      const res = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        Body?: unknown;
      };
      if (!res.Body) throw new Error('empty_body');
      return res.Body as Readable;
    },
  };
}
```

- [ ] **Step 5: 实现 `apps/bff/src/artifacts/artifacts.service.ts`**

```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { ArtifactDto, ArtifactRef } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { ARTIFACT_STORAGE, type ArtifactStorage } from './storage';

@Injectable()
export class ArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage,
  ) {}

  /** 落库一条产物；version 按 (sessionId, filename) 递增，同名重生成即升版。 */
  async record(
    runId: string,
    sessionId: string,
    tenantId: string,
    ref: ArtifactRef,
  ): Promise<void> {
    const agg = await this.prisma.artifact.aggregate({
      where: { sessionId, filename: ref.filename },
      _max: { version: true },
    });
    const version = (agg._max.version ?? 0) + 1;
    await this.prisma.artifact.create({
      data: {
        tenantId,
        sessionId,
        runId,
        kind: ref.kind,
        filename: ref.filename,
        storageKey: ref.storageKey,
        size: ref.size,
        version,
      },
    });
  }

  async list(sessionId: string, tenantId: string, userId: string): Promise<ArtifactDto[]> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);
    const rows = await this.prisma.artifact.findMany({
      where: { sessionId, tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((a) => ({
      id: a.id,
      kind: a.kind as ArtifactDto['kind'],
      filename: a.filename,
      size: a.size,
      version: a.version,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  /** 校验租户归属并取对象流；DB 无行 → 404（不泄露存在性），取流失败由调用方转 502。 */
  async getForDownload(
    id: string,
    tenantId: string,
  ): Promise<{ filename: string; kind: string; stream: Readable }> {
    const a = await this.prisma.artifact.findFirst({ where: { id, tenantId } });
    if (!a) throw new NotFoundException('artifact_not_found');
    const stream = await this.storage.getObjectStream(a.storageKey);
    return { filename: a.filename, kind: a.kind, stream };
  }
}
```

- [ ] **Step 6: 运行 service 测试确认通过**

Run: `pnpm --filter @ai-office/bff test -- artifacts.service`
Expected: PASS（6 条）。

- [ ] **Step 7: 写失败测试 `apps/bff/src/artifacts/artifacts.controller.test.ts`**

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Readable } from 'node:stream';
import { ArtifactController } from './artifacts.controller';
import { ArtifactService } from './artifacts.service';
import { ARTIFACT_STORAGE, type ArtifactStorage } from './storage';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;
let baseUrl: string;

const row = {
  id: 'a1',
  tenantId: 't1',
  sessionId: 's1',
  runId: 'r1',
  kind: 'pptx',
  filename: '报告.pptx',
  storageKey: 'k',
  size: 5,
  version: 1,
  createdAt: new Date(),
};

const fakePrisma = {
  artifact: {
    findMany: async () => [row],
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
      where.id === row.id && where.tenantId === row.tenantId ? row : null,
  },
} as unknown as PrismaService;

const fakeSessions = {
  assertOwned: async () => {},
} as unknown as SessionsService;

const fakeStorage = {
  getObjectStream: async () => Readable.from([Buffer.from('hello')]),
} as unknown as ArtifactStorage;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [ArtifactController],
    providers: [
      ArtifactService,
      { provide: PrismaService, useValue: fakePrisma },
      { provide: SessionsService, useValue: fakeSessions },
      { provide: ARTIFACT_STORAGE, useValue: fakeStorage },
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
});

describe('ArtifactController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/artifacts/a1/download' });
    expect(res.statusCode).toBe(401);
  });

  it('列表返回会话产物', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/artifacts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { filename: string }[];
    expect(body[0].filename).toBe('报告.pptx');
  });

  it('下载设置正确响应头并回传字节', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/artifacts/a1/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('presentationml');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toBe('hello');
  });

  it('越租户下载返回 404', async () => {
    const token = signToken({ sub: 'u2', tenantId: 't9' });
    const res = await fetch(`${baseUrl}/api/artifacts/a1/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('对象缺失返回 502', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const broken = {
      getObjectStream: async () => {
        throw new Error('NoSuchKey');
      },
    } as unknown as ArtifactStorage;
    // 换一个拿不到对象的 storage：直接构造一个临时应用代价过高，
    // 改为对单例 storage 打桩后恢复，保证用例彼此独立。
    const original = fakeStorage.getObjectStream;
    (fakeStorage as { getObjectStream: ArtifactStorage['getObjectStream'] }).getObjectStream =
      broken.getObjectStream;
    try {
      const res = await fetch(`${baseUrl}/api/artifacts/a1/download`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(502);
    } finally {
      (fakeStorage as { getObjectStream: ArtifactStorage['getObjectStream'] }).getObjectStream =
        original;
    }
  });
});
```

- [ ] **Step 8: 实现 `apps/bff/src/artifacts/artifacts.controller.ts`**

```ts
import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ArtifactDto } from '@ai-office/shared';
import { ArtifactService } from './artifacts.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 兼容非 ASCII 文件名：ASCII 回退 + RFC 5987 的 filename*。 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller('api')
@UseGuards(JwtGuard)
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactService) {}

  @Get('sessions/:id/artifacts')
  list(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<ArtifactDto[]> {
    return this.artifacts.list(id, user.tenantId, user.sub);
  }

  @Get('artifacts/:id/download')
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let result: { filename: string; kind: string; stream: NodeJS.ReadableStream };
    try {
      result = await this.artifacts.getForDownload(id, user.tenantId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'not_found' });
        return;
      }
      // DB 有行但对象缺失（或对象存储不可达）：回 502，区分于「不存在」。
      reply.status(502).send({ error: 'object_unavailable' });
      return;
    }
    reply.header('content-type', MIME[result.kind] ?? 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(result.filename));
    await reply.send(result.stream);
  }
}
```

- [ ] **Step 9: 修改 `apps/bff/src/app.module.ts` 注册 artifacts**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './db/prisma.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { ArtifactController } from './artifacts/artifacts.controller';
import { ArtifactService } from './artifacts/artifacts.service';
import { ARTIFACT_STORAGE, createArtifactStorage } from './artifacts/storage';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController, SessionsController, TasksController, ArtifactController],
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

- [ ] **Step 10: 运行 controller 测试确认通过**

Run: `pnpm --filter @ai-office/bff test -- artifacts.controller`
Expected: PASS（5 条）。

- [ ] **Step 11: Commit**

```bash
git add apps/bff/package.json apps/bff/src/artifacts apps/bff/src/app.module.ts pnpm-lock.yaml
git commit -m "feat(bff): 增加产物落库、列表与下载代理

MinIO 保持内网私有，下载由 BFF 代理并在唯一入口做租户校验；
不存在与对象缺失分别回 404/502，避免混淆。"
```

---

## Task 11: tasks 转发携带 tenantId 并落 artifact

**Files:**
- Modify: `apps/bff/src/tasks/tasks.controller.ts`
- Modify: `apps/bff/src/tasks/tasks.service.ts`
- Test: `apps/bff/src/tasks/tasks.controller.test.ts`

- [ ] **Step 1: 在 `tasks.service.ts` 的 `prepare` 返回值加入 `tenantId`**

把签名与返回改为：

```ts
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
  ): Promise<{ taskId: string; runId: string; tenantId: string; messages: ChatMessage[] }> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);
    // ...（其余不变）
    return { taskId: task.id, runId: run.id, tenantId, messages };
  }
```

- [ ] **Step 2: 在 `tasks.controller.ts` 注入 `ArtifactService` 并改请求体、落库**

顶部 import 增加：

```ts
import type { ArtifactRef } from '@ai-office/shared';
import { ArtifactService } from '../artifacts/artifacts.service';
```

构造函数：

```ts
  constructor(
    private readonly tasks: TasksService,
    private readonly artifacts: ArtifactService,
  ) {}
```

`prepare` 解构补 `tenantId`：

```ts
    const { taskId, runId, tenantId, messages } = await this.tasks.prepare(
      sessionId,
      user.tenantId,
      user.sub,
      goal,
    );
```

转发请求体带 `tenantId`：

```ts
        body: JSON.stringify({ runId, sessionId, tenantId, goal, messages }),
```

在解析循环的 `if (m.event === 'step')` 分支内、`recordStep` 之后追加 artifact 落库：

```ts
            if (ev.type === 'artifact') {
              await this.safeRecordArtifact(runId, sessionId, tenantId, ev.payload);
            }
```

新增私有方法：

```ts
  /** 产物落库失败只记日志，绝不中断 SSE 流（与 safeFinish 同样的容错姿态）。 */
  private async safeRecordArtifact(
    runId: string,
    sessionId: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.artifacts.record(runId, sessionId, tenantId, payload as unknown as ArtifactRef);
    } catch (err) {
      this.logger.error(`run ${runId} artifact 落库失败: ${(err as Error).message}`);
    }
  }
```

- [ ] **Step 3: 更新 `tasks.controller.test.ts`：fake 补 artifact 表 + 注入 ArtifactService + 上游发 artifact step**

在 `stored` 对象加字段：

```ts
const stored: {
  steps: unknown[];
  messages: unknown[];
  runUpdates: unknown[];
  taskUpdates: unknown[];
  artifacts: unknown[];
} = { steps: [], messages: [], runUpdates: [], taskUpdates: [], artifacts: [] };
```

`fakePrisma` 增：

```ts
  artifact: {
    aggregate: async () => ({ _max: { version: null } }),
    create: async ({ data }: { data: unknown }) => {
      stored.artifacts.push(data);
      return data;
    },
  },
```

`Test.createTestingModule` 的 `providers` 增加 ArtifactService，并为其注入假 storage：

```ts
    providers: [
      SessionsService,
      TasksService,
      ArtifactService,
      { provide: PrismaService, useValue: fakePrisma },
      { provide: ARTIFACT_STORAGE, useValue: { getObjectStream: async () => { throw new Error('unused'); } } },
    ],
```

并在文件顶部补 import：

```ts
import { ArtifactService } from '../artifacts/artifacts.service';
import { ARTIFACT_STORAGE } from '../artifacts/storage';
```

`beforeEach` 中补 `stored.artifacts.length = 0;`。

上游 `'ok'` 模式追加一条 artifact step（放在 tool_call 之后、usage 之前）：

```ts
    res.write(encodeSse({ event: 'step', data: { runId: 'run1', seq: 2, type: 'artifact', payload: { kind: 'pptx', filename: 'a.pptx', storageKey: 'k', size: 3 }, ts: 3 } }));
```

把既有用例「透传 SSE 且把 step 落库」的断言从 `toHaveLength(2)` 改为 `toHaveLength(3)`，并新增：

```ts
  it('SSE 里的 artifact step 触发产物落库', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ goal: '生成 PPT' }),
    });
    await res.text();
    expect(stored.artifacts).toHaveLength(1);
    expect(stored.artifacts[0]).toMatchObject({ filename: 'a.pptx', kind: 'pptx' });
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-office/bff test -- tasks.controller`
Expected: PASS（既有用例 + 新增 1 条）。

- [ ] **Step 5: bff 全量测试与类型检查**

Run: `pnpm --filter @ai-office/bff test`
Run: `pnpm --filter @ai-office/bff typecheck`
Expected: 均通过。

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/tasks/tasks.controller.ts apps/bff/src/tasks/tasks.service.ts apps/bff/src/tasks/tasks.controller.test.ts
git commit -m "feat(bff): 转发时落库产物并透传 tenantId

runtime 拼存储 Key 需要 tenantId，BFF 从 JWT 取出后随 RunRequest 一并转发；
收到 artifact step 即落 Artifact 表，落库失败只记日志、不中断 SSE。"
```

---

## Task 12: web 工作台成果区

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/render-step.ts`
- Modify: `apps/web/src/lib/render-step.test.ts`
- Modify: `apps/web/src/app/page.tsx`

- [ ] **Step 1: 更新 `render-step.test.ts` 的 artifact 用例**

把该用例改为：

```ts
  it('artifact 展示产出文件名与类型', () => {
    const out = renderStep(ev('artifact', { kind: 'pptx', filename: '报告.pptx' }));
    expect(out).toContain('报告.pptx');
    expect(out).toContain('pptx');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-office/web test`
Expected: FAIL —— 当前 artifact 分支输出的是 JSON。

- [ ] **Step 3: 修改 `apps/web/src/lib/render-step.ts` 的 artifact 分支**

```ts
    case 'artifact': {
      const kind = String(ev.payload.kind ?? '');
      const filename = String(ev.payload.filename ?? '');
      return `产出文档 ${filename}（${kind}）`;
    }
```

- [ ] **Step 4: 在 `apps/web/src/lib/api.ts` 增加两个函数**

顶部类型 import 补 `ArtifactDto`：

```ts
import type { ArtifactDto, AuthResponse, SessionSummary } from '@ai-office/shared';
```

文件末尾追加：

```ts
export async function listArtifacts(sessionId: string): Promise<ArtifactDto[]> {
  const res = await authFetch(`/api/sessions/${sessionId}/artifacts`);
  if (!res.ok) throw new Error(`artifacts_failed_${res.status}`);
  return (await res.json()) as ArtifactDto[];
}

/**
 * 下载产物：JWT 走请求头，故不能用 <a href>，须 fetch 取 blob 再触发保存。
 * 文件名从 DTO 传入——浏览器不会把 content-disposition 应用到程序化下载。
 */
export async function downloadArtifact(id: string, filename: string): Promise<void> {
  const res = await authFetch(`/api/artifacts/${id}/download`);
  if (!res.ok) throw new Error(`download_failed_${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: 修改 `apps/web/src/app/page.tsx` 增加成果区**

import 补类型与函数：

```tsx
import type { AgentEvent, ArtifactDto, SessionSummary } from '@ai-office/shared';
```

```tsx
import {
  clearToken,
  createSession,
  downloadArtifact,
  getToken,
  isUnauthorized,
  listArtifacts,
  listSessions,
  streamTask,
} from '../lib/api';
```

新增 state：

```tsx
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
```

新增加载函数并在会话切换时刷新：

```tsx
  async function refreshArtifacts(sid: string) {
    if (!sid) {
      setArtifacts([]);
      return;
    }
    try {
      setArtifacts(await listArtifacts(sid));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(String(err));
    }
  }

  useEffect(() => {
    void refreshArtifacts(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
```

在 `run()` 中：收到 artifact step 时乐观追加一张卡片（尚无 DB id，暂不可下载），并在流结束后重新拉取以获得带 id 的权威列表：

```tsx
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            setEvents((prev) => [...prev, ev]);
            if (ev.type === 'artifact') {
              setArtifacts((prev) => [
                {
                  id: '',
                  kind: String(ev.payload.kind ?? 'docx') as ArtifactDto['kind'],
                  filename: String(ev.payload.filename ?? ''),
                  size: Number(ev.payload.size ?? 0),
                  version: 0,
                  createdAt: new Date().toISOString(),
                },
                ...prev,
              ]);
            }
          }
```

`run()` 的 `finally` 中补刷新：

```tsx
    } finally {
      setRunning(false);
      void refreshArtifacts(sid);
    }
```

（注意 `sid` 在 try 内已就绪；若 try 在 `sid` 赋值前抛出则 `sid` 为原始 `sessionId`，`refreshArtifacts` 对空串已做保护。）

在 `<ol>` 之后渲染成果区：

```tsx
      <h2 style={{ marginTop: 24 }}>成果区</h2>
      {artifacts.length === 0 ? (
        <p style={{ color: '#888' }}>暂无产出</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {artifacts.map((a, i) => (
            <li key={a.id || `pending-${i}`} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>{a.filename}</div>
              <div style={{ color: '#666', fontSize: 13 }}>
                {a.kind} · {a.size} 字节 · v{a.version} · {new Date(a.createdAt).toLocaleString()}
              </div>
              {a.id ? (
                <button
                  style={{ marginTop: 8 }}
                  onClick={() => void downloadArtifact(a.id, a.filename).catch((e) => setError(String(e)))}
                >
                  下载
                </button>
              ) : (
                <span style={{ color: '#999', fontSize: 13 }}>落库中…</span>
              )}
            </li>
          ))}
        </ul>
      )}
```

- [ ] **Step 6: 运行 web 测试与构建**

Run: `pnpm --filter @ai-office/web test`
Expected: PASS（含更新后的 artifact 渲染用例）。

Run: `pnpm --filter @ai-office/web build`
Expected: 构建成功，无类型错误。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/render-step.ts apps/web/src/lib/render-step.test.ts apps/web/src/app/page.tsx
git commit -m "feat(web): 工作台增加成果区与下载

成果区嵌在工作台内，切会话即刷新；artifact step 到达时乐观追加卡片，
流结束后重新拉取带 id 的权威列表以启用下载（JWT 走请求头，须 fetch 取 blob）。"
```

---

## Task 13: 端到端验证与文档

**Files:**
- Modify: `README.md`（若存在「本地起服务」小节，补 MinIO 与 S3 配置说明）

- [ ] **Step 1: 起全栈**

Run: `cd apps/bff && docker-compose up -d`
Run: `pnpm dev`
Expected: runtime 打印 `agent-runtime listening on http://127.0.0.1:4001`；bff 打印 `bff listening on http://localhost:4000`；web 在 3000。runtime 启动时无 `ensureBucket 失败` 告警。

- [ ] **Step 2: 确认桶已建**

Run: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9000/minio/health/live`
Expected: `200`（桶 `artifacts` 由 runtime 启动时创建，可用 MinIO 控制台 http://127.0.0.1:9001 目视确认）。

- [ ] **Step 3: 用真实模型跑一次文档生成**

需真实 `DEEPSEEK_API_KEY`（`MockGateway` 只会调 `web.search`，不触发文档工具）。

先注册取 token：

```bash
curl -s -X POST http://localhost:4000/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"m2@example.com","password":"passw0rd"}' | tee /tmp/auth.json
```

建会话：

```bash
curl -s -X POST http://localhost:4000/api/sessions -H 'content-type: application/json' \
  -H "authorization: Bearer $(python -c "import json;print(json.load(open('/tmp/auth.json'))['token'])")" \
  -d '{}'
```

下达目标（用 UTF-8 文件传 body，规避 Windows curl 的编码问题）：

```bash
printf '%s' '{"goal":"生成一份三页 PPT，主题是季度复盘"}' > /tmp/goal.json
curl -N -X POST http://localhost:4000/api/sessions/<SESSION_ID>/tasks \
  -H 'content-type: application/json' \
  -H "authorization: Bearer <TOKEN>" \
  --data-binary @/tmp/goal.json
```

Expected: SSE 中出现 `event: step` 且 data 含 `"type":"artifact"`，payload 为 `{kind,filename,storageKey,size}`；随后 `event: done`。

- [ ] **Step 4: 拉列表并下载**

```bash
curl -s http://localhost:4000/api/sessions/<SESSION_ID>/artifacts -H "authorization: Bearer <TOKEN>"
```

Expected: 返回 `[{id,kind,filename,size,version,createdAt}]`。

```bash
curl -s -D - -o /tmp/out.pptx http://localhost:4000/api/artifacts/<ARTIFACT_ID>/download \
  -H "authorization: Bearer <TOKEN>"
```

Expected: 200，`content-type` 含 `presentationml`，`content-disposition` 含 `attachment`；`/tmp/out.pptx` 以 `PK` 开头（合法 zip），可用 PowerPoint 打开。

- [ ] **Step 5: 浏览器复核**

打开 http://localhost:3000，登录后选择该会话：成果区出现卡片（文件名 / 类型 / 大小 / 版本 / 时间），点「下载」得到 pptx。

- [ ] **Step 6: 越权校验**

用另一个账号的 token 请求上一步的 `ARTIFACT_ID`：
Expected: 404。

- [ ] **Step 7: 全量测试与构建**

Run: `pnpm test`
Run: `pnpm build`
Expected: 四包测试全绿、构建全绿。

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: 补充 M2 本地运行所需的 MinIO 与 S3 配置说明"
```

---

## Self-Review

**Spec 覆盖**
- §2/§3 分层与数据流：Task 3（infra）、4（storage）、6（tools）、7（artifact step）、10/11（bff）、12（web）。
- §4 Prisma `Artifact` + 反向关系 + version 递增：Task 9、Task 10 Step 5。
- §5 shared 契约（`RunRequest.tenantId`、`ArtifactRef`、`ArtifactDto`）：Task 1。
- §6 doc 三工具 + `RunContext` + agent-loop 变更：Task 2、5、6、7。
- §7 `storage/s3.ts`（path-style / putObject / getObjectStream / ensureBucket）：Task 4、8。
- §8 BFF artifacts 模块（record/list/getForDownload、路由、tasks.controller 落库、prepare 带 tenantId）：Task 10、11。
- §9 web（`listArtifacts`/`downloadArtifact`、render-step、成果区）：Task 12。
- §10 错误处理（工具失败继续、落库失败不中断、下载 404/502）：Task 7、10、11。
- §11 测试（生成器反解、agent-loop artifact、storage、service、controller、tasks.controller）：Task 2/5/6/7/4/10/11。
- §12 未决项（预览、预签名、生命周期）：本期不实现，未列入。

**占位符扫描**：无 TBD/TODO；每个改动步骤均含完整代码；无「同上」「类似 Task N」的偷懒引用。

**类型一致性**
- `RunContext{tenantId,sessionId,runId}`（Task 2）在 `doc.ts`（Task 6）与 `agent-loop.ts`（Task 2/7）用法一致。
- `Storage{ensureBucket,putObject,getObjectStream}`（Task 4）与 `doc.test.ts`、`server.test.ts`（Task 8）的假实现字段一致。
- `ArtifactRef{kind,filename,storageKey,size}`（Task 1）在 runtime 工具返回（Task 6）、agent-loop 透传（Task 7）、BFF `record`（Task 10）、tasks.controller 校验（Task 11）四处结构一致。
- `ArtifactDto{id,kind,filename,size,version,createdAt}`（Task 1）与 `ArtifactService.list`（Task 10）、`api.listArtifacts`、成果区卡片（Task 12）一致。
- `ARTIFACT_STORAGE` 令牌与 `ArtifactStorage` 类型（Task 10 Step 4）在 service/controller/app.module/两处测试中名字一致。
- 路由前缀：`ArtifactController` 用 `@Controller('api')` + `sessions/:id/artifacts`、`artifacts/:id/download`（Task 10），与 web 端 `listArtifacts`/`downloadArtifact` 路径（Task 12）一致。

**已知环境注意点**
- 本机 `docker compose` 插件可能缺失，用独立 `docker-compose`。
- 该环境 `docker exec` 的 stdout 不被工具捕获，验证走 host 的 `curl` 与 BFF 接口，不用 `docker exec`。
- Windows 下 `curl -d` 传中文会乱码，用 `--data-binary @file`（Task 13 Step 3）。
