import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import {
  currentContext,
  currentTrace,
  initTelemetry,
  shutdownTelemetry,
} from '@ai-office/telemetry';
import { decodeSseFrames, createSseParser } from '@ai-office/shared';
import type { AgentEvent, RuntimeSummaryDto } from '@ai-office/shared';
import { createRuntimeServer, filterTools, isLoopback } from './server';
import { createRuntimeMetrics } from './observability/metrics';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';

// 测试不校验日志输出；保持 stdout 干净。
process.env.LOG_LEVEL = 'silent';

const echo: Tool = {
  name: 'web.search',
  description: 'd',
  parameters: {},
  permission: 'safe',
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
        usage: { input: 1, output: 1 }, model: 'mock',
      };
    }
    return { content: '完成', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
  },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  initTelemetry({ serviceName: 'agent-runtime-test', serviceVersion: '1' });
  server = createRuntimeServer({ gateway: scripted, tools: [echo] });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await shutdownTelemetry();
});

async function postRuns(payload: unknown) {
  return fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('isLoopback', () => {
  it('识别 IPv4 / IPv6 与双栈映射地址', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.8.9.10')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('远程地址与缺失地址一律判否（fail-closed）', () => {
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback('::ffff:10.0.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

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
    expect(messages.map((m) => m.event)).toEqual(['step', 'step', 'step', 'step', 'usage', 'done']);
  });

  it('首个模型事件较慢时也先下发 SSE 响应头，避免被建连超时中断', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: ModelGateway = {
      async chat() {
        await gate;
        return { content: '完成', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
      },
    };
    const slowServer = createRuntimeServer({ gateway: slow, tools: [] });
    await new Promise<void>((resolve) => slowServer.listen(0, resolve));
    const addr = slowServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const pending = fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: 'slow',
          sessionId: 's1',
          goal: 'g',
          messages: [{ role: 'user', content: 'g' }],
        }),
      });
      // 此时模型还没有返回任何事件；响应头仍必须立即到达，
      // 否则 BFF 的 10s 建连超时会把「等待首 token」当成上游不可达。
      const res = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('headers_not_flushed')), 2000);
          timer.unref();
        }),
      ]);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      release();
      expect(await res.text()).toContain('event: done');
    } finally {
      release();
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
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

  it('设置 AGENT_RUNTIME_TOKEN 后：缺 token 返回 401，正确 token 放行', async () => {
    process.env.AGENT_RUNTIME_TOKEN = 'secret-tok';
    try {
      const payload = {
        runId: 'r1',
        sessionId: 's1',
        goal: 'g',
        messages: [{ role: 'user', content: 'g' }],
      };
      const denied = await postRuns(payload);
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${baseUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runtime-token': 'secret-tok' },
        body: JSON.stringify(payload),
      });
      expect(allowed.status).toBe(200);
      await allowed.text(); // 排空响应体，避免连接悬挂
    } finally {
      delete process.env.AGENT_RUNTIME_TOKEN;
    }
  });

  it('网关抛错时 SSE 只吐 error 事件、不含 done', async () => {
    const boomGateway: ModelGateway = {
      async chat() {
        throw new Error('boom');
      },
    };
    // 独立的 server，避免污染共享的 server/baseUrl。
    const errServer = createRuntimeServer({ gateway: boomGateway, tools: [echo] });
    await new Promise<void>((r) => errServer.listen(0, r));
    const addr = errServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const errBaseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${errBaseUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: 'r1',
          sessionId: 's1',
          goal: 'g',
          messages: [{ role: 'user', content: 'g' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const messages = decodeSseFrames(await res.text());
      // server.ts 的 catch 只写 error（第 57-58 行），finally 直接 end（第 59-61 行），
      // 错误路径不写 done —— 故真实序列只有 ['error']。
      expect(messages.map((m) => m.event)).toEqual(['error']);
      const err = messages.find((m) => m.event === 'error');
      expect((err?.data as { message: string }).message).toContain('boom');
    } finally {
      await new Promise<void>((r) => errServer.close(() => r()));
    }
  });

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
          return { content: 'hi', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
        },
      },
      tools: [],
      storage,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'r', sessionId: 's', tenantId: 't', userId: 'u', goal: 'g', messages: [] }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('GET /metrics 输出 Prometheus 文本，GET /metrics/summary 夹取窗口', async () => {
    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('ai_office_active_runs');

    const summary = await fetch(`${baseUrl}/metrics/summary?windowMinutes=999`);
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as RuntimeSummaryDto;
    expect(body.windowMinutes).toBe(60);
    // 注入的 scripted 网关不经过 createGateway 观察者，窗口内没有模型样本。
    expect(body.status).toBe('insufficient_data');
    expect(body.activeRuns).toBe(0);
  });

  it('设置 AGENT_RUNTIME_TOKEN 后指标端点缺 token 返回 401', async () => {
    process.env.AGENT_RUNTIME_TOKEN = 'secret-tok';
    try {
      expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/metrics/summary`)).status).toBe(401);
      const allowed = await fetch(`${baseUrl}/metrics`, {
        headers: { 'x-agent-runtime-token': 'secret-tok' },
      });
      expect(allowed.status).toBe(200);
      await allowed.text();
    } finally {
      delete process.env.AGENT_RUNTIME_TOKEN;
    }
  });

  it('从 traceparent 续接 traceId，并把工具调用计入指标', async () => {
    const metrics = createRuntimeMetrics({ defaultMetrics: false });
    let seen: { traceId?: string; runId?: string } = {};
    let round = 0;
    const capture: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          seen = { traceId: currentTrace()?.traceId, runId: currentContext().runId };
          return {
            content: '搜索',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 1, output: 1 },
            model: 'mock',
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
      },
    };
    const srv = createRuntimeServer({ gateway: capture, tools: [echo], metrics });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: `00-${traceId}-b7ad6b7169203331-01`,
        },
        body: JSON.stringify({
          runId: 'r-trace',
          sessionId: 's1',
          tenantId: 't1',
          userId: 'u1',
          goal: 'g',
          messages: [{ role: 'user', content: 'g' }],
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(seen).toEqual({ traceId, runId: 'r-trace' });
      const text = await metrics.registry.metrics();
      expect(text).toContain('ai_office_tool_calls_total{tool="web.search",status="ok"} 1');
      expect(text).toContain('ai_office_active_runs 0');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('runtime 确认端点', () => {
  function confirmServer() {
    const confirmTool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        return { stdout: 'sandbox-ok' };
      },
    };
    const scripted: ModelGateway = {
      async chat({ messages }) {
        const hasTool = messages.some((m) => m.role === 'tool');
        if (!hasTool) {
          return {
            content: '执行',
            toolCalls: [{ id: 'c1', name: 'code.exec', args: {} }],
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    return createRuntimeServer({ gateway: scripted, tools: [confirmTool] });
  }

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return `http://127.0.0.1:${addr.port}`;
  }

  const body = (runId: string) => ({
    runId,
    sessionId: 's',
    tenantId: 't',
    userId: 'u',
    goal: 'g',
    messages: [{ role: 'user', content: 'g' }],
  });

  /** 读到首个 confirm_request 为止，返回其 confirmId 与继续读取用的 reader/parse。 */
  async function readUntilConfirm(res: Response) {
    const reader = res.body!.getReader();
    const parse = createSseParser();
    const decoder = new TextDecoder();
    const types: string[] = [];
    let confirmId = '';
    while (!confirmId) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parse(decoder.decode(value, { stream: true }))) {
        if (m.event === 'step') {
          const ev = m.data as AgentEvent;
          types.push(ev.type);
          if (ev.type === 'confirm_request') confirmId = String(ev.payload.confirmId);
        }
      }
    }
    return { reader, parse, decoder, types, confirmId };
  }

  it('放行后 run 继续并产出 tool_result', async () => {
    const server = confirmServer();
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body('rc')),
      });
      const { reader, parse, decoder, types, confirmId } = await readUntilConfirm(res);
      expect(confirmId).not.toBe('');

      const cr = await fetch(`${base}/runs/rc/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmId, approved: true }),
      });
      expect(await cr.json()).toEqual({ ok: true, matched: true });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parse(decoder.decode(value, { stream: true }))) {
          if (m.event === 'step') types.push((m.data as AgentEvent).type);
        }
      }
      expect(types).toContain('tool_result');
      expect(types).toContain('confirm_request');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('未知 run / 重复 confirm 返回 200 matched:false（幂等）', async () => {
    const server = confirmServer();
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/runs/unknown/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmId: 'nope', approved: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, matched: false });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('body 非法返回 400', async () => {
    const server = confirmServer();
    const base = await listen(server);
    try {
      for (const payload of [{}, { confirmId: '', approved: true }, { confirmId: 'c', approved: 'yes' }]) {
        const res = await fetch(`${base}/runs/r1/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('等待确认时客户端断开 → 闸门按拒绝兑现（随后 confirm 返回 matched:false）', async () => {
    const server = confirmServer();
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body('rd')),
      });
      const { reader, confirmId } = await readUntilConfirm(res);
      expect(confirmId).not.toBe('');
      // 断开客户端：服务端 res 触发 close → broker.cancel(runId)。
      await reader.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      const cr = await fetch(`${base}/runs/rd/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmId, approved: true }),
      });
      expect(await cr.json()).toEqual({ ok: true, matched: false });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('设置 AGENT_RUNTIME_TOKEN 后：confirm 端点缺 token 返回 401', async () => {
    process.env.AGENT_RUNTIME_TOKEN = 'secret-tok';
    const server = confirmServer();
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/runs/r1/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmId: 'c', approved: true }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      delete process.env.AGENT_RUNTIME_TOKEN;
    }
  });
});

describe('runtime 摄取端点', () => {
  const txtStorage = {
    ensureBucket: async () => {},
    putObject: async () => {},
    getObjectStream: async () => Readable.from([Buffer.from('甲'.repeat(2000), 'utf8')]),
  };

  let srv: Server;
  let base: string;

  beforeAll(async () => {
    srv = createRuntimeServer({
      gateway: { async chat() { return { content: '', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' }; } },
      tools: [],
      storage: txtStorage,
      embedding: { dim: 3, async embed(texts) { return texts.map((t) => [t.length, 0, 0]); } },
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('摄取成功：返回 ok 与连续 seq 的切片', async () => {
    const res = await fetch(`${base}/kb/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storageKey: 'k', filename: 'a.txt', mime: 'text/plain' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; chunks: { seq: number; vector: number[] }[] };
    expect(data.ok).toBe(true);
    expect(data.chunks.map((c) => c.seq)).toEqual(data.chunks.map((_, i) => i));
    expect(data.chunks[0].vector.length).toBe(3);
  });

  it('解析失败：返回 ok:false 与 error', async () => {
    const res = await fetch(`${base}/kb/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storageKey: 'k', filename: 'a.exe', mime: 'application/octet-stream' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });

  it('设置 AGENT_RUNTIME_TOKEN 后缺 token 返回 401', async () => {
    process.env.AGENT_RUNTIME_TOKEN = 'secret-tok';
    try {
      const res = await fetch(`${base}/kb/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storageKey: 'k', filename: 'a.txt' }),
      });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.AGENT_RUNTIME_TOKEN;
    }
  });

  it('请求体为 JSON null：返回 400 而非崩溃/挂起', async () => {
    const res = await fetch(`${base}/kb/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });
});

describe('POST /connectors/validate', () => {
  const stubGateway: ModelGateway = {
    async chat() { return { content: '', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' }; },
  };

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return `http://127.0.0.1:${addr.port}`;
  }

  it('通过：回 { ok:true, tools }', async () => {
    const server = createRuntimeServer({
      gateway: stubGateway,
      tools: [],
      validateConnector: async () => [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }],
    });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/connectors/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'node', args: ['s.mjs'], env: {} }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, tools: [{ name: 'echo' }] });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('失败：回 { ok:false, error }', async () => {
    const server = createRuntimeServer({
      gateway: stubGateway,
      tools: [],
      validateConnector: async () => { throw new Error('spawn_failed'); },
    });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/connectors/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'nope' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, error: 'spawn_failed' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('缺少 token 时回 401', async () => {
    const prev = process.env.AGENT_RUNTIME_TOKEN;
    process.env.AGENT_RUNTIME_TOKEN = 'secret';
    const server = createRuntimeServer({
      gateway: stubGateway,
      tools: [],
      validateConnector: async () => [],
    });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/connectors/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'node' }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.AGENT_RUNTIME_TOKEN;
      else process.env.AGENT_RUNTIME_TOKEN = prev;
    }
  });

  it('非法 JSON 回 400 invalid json', async () => {
    const server = createRuntimeServer({ gateway: stubGateway, tools: [], validateConnector: async () => [] });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/connectors/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid json' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('缺少 command 回 400 missing_command（对象命令也算缺失）', async () => {
    const server = createRuntimeServer({ gateway: stubGateway, tools: [], validateConnector: async () => [] });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/connectors/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: { evil: true } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'missing_command' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('/runs 的 per-run MCP 工具拼装', () => {
  it('extraTools 按 tenantId 被调用，其结果并入模型工具列表', async () => {
    const seen: string[] = [];
    const toolNames: string[] = [];
    const mcpTool: Tool = {
      name: 'mcp.x.y',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() { return { ok: true }; },
    };
    const gateway: ModelGateway = {
      async chat(req) {
        toolNames.push(...req.tools.map((t) => t.name));
        return { content: '完成', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const server = createRuntimeServer({
      gateway,
      tools: [echo],
      extraTools: async (tenantId) => { seen.push(tenantId); return [mcpTool]; },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'r1', sessionId: 's1', tenantId: 't1', userId: 'u1', goal: 'g', messages: [] }),
      });
      await res.text();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(seen).toEqual(['t1']);
    expect(toolNames).toContain('mcp.x.y');
    expect(toolNames).toContain('web.search'); // 既有 base 工具仍在
  });
});

describe('run 级模型路由', () => {
  it('下发了 modelRoutes 时优先使用本次路由', async () => {
    let seenModel = '';
    const modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seenModel = (JSON.parse(raw || '{}') as { model?: string }).model ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '来自下发路由' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => modelServer.listen(0, r));
    const addr = modelServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const res = await postRuns({
        runId: 'r-route',
        sessionId: 's1',
        tenantId: 't1',
        userId: 'u1',
        goal: 'g',
        messages: [{ role: 'user', content: 'g' }],
        modelRoutes: [
          { model: 'doubao-x', baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'sk' },
        ],
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain('来自下发路由');
      expect(seenModel).toBe('doubao-x');
    } finally {
      await new Promise<void>((r) => modelServer.close(() => r()));
    }
  });
});

describe('filterTools', () => {
  const tools: Tool[] = [
    { name: 'web.search', description: '', parameters: {}, permission: 'safe', execute: async () => ({}) },
    { name: 'code.exec', description: '', parameters: {}, permission: 'confirm', execute: async () => ({}) },
  ];

  it('未绑定助手（undefined）时返回全部工具', () => {
    expect(filterTools(tools, undefined).map((t) => t.name)).toEqual(['web.search', 'code.exec']);
  });

  it('按技能白名单过滤；空数组禁用全部内置工具', () => {
    expect(filterTools(tools, ['web.search']).map((t) => t.name)).toEqual(['web.search']);
    expect(filterTools(tools, [])).toEqual([]);
  });
});

