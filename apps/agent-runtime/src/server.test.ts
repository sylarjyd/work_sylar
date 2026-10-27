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
import type {
  AgentEvent,
  RunCheckpointEvent,
  RuntimeSummaryDto,
  UsageEvent,
} from '@ai-office/shared';
import { createRuntimeServer, filterTools, isLoopback, isValidResume } from './server';
import { createRuntimeMetrics } from './observability/metrics';
import type { ModelGateway } from './model/types';
import type { Storage } from './storage/s3';
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

describe('isValidResume', () => {
  const base = { round: 0, seq: 0, deltas: [], usage: [] };

  it('round/seq 允许到 20 亿，超过即拒绝（为 Prisma Int 自增预留余量）', () => {
    expect(isValidResume({ ...base, round: 2_000_000_000, seq: 2_000_000_000 })).toBe(true);
    expect(isValidResume({ ...base, round: 2_000_000_001 })).toBe(false);
    expect(isValidResume({ ...base, seq: 2_000_000_001 })).toBe(false);
  });

  it('工具调用未配对时禁止插入 assistant；正常往返顺序仍合法', () => {
    const call = (id: string) => ({ id, name: 'n', args: {} });
    expect(
      isValidResume({
        ...base,
        deltas: [
          { role: 'assistant', content: 'x', toolCalls: [call('c1')] },
          { role: 'assistant', content: '插队' },
          { role: 'tool', content: 'x', toolCallId: 'c1' },
        ],
      }),
    ).toBe(false);
    // 调用 → 结果 → 下一轮调用 → 结果：每段往返都紧邻，应当放行。
    expect(
      isValidResume({
        ...base,
        deltas: [
          { role: 'assistant', content: 'x', toolCalls: [call('c1')] },
          { role: 'tool', content: 'x', toolCallId: 'c1' },
          { role: 'assistant', content: 'y', toolCalls: [call('c2')] },
          { role: 'tool', content: 'y', toolCallId: 'c2' },
        ],
      }),
    ).toBe(true);
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
    expect(messages.map((m) => m.event)).toEqual([
      'step',
      'step',
      'step',
      'checkpoint',
      'step',
      'usage',
      'done',
    ]);
    // 第一轮工具结束后落 checkpoint：seq 指向下一个未用序号，
    // 用量为发出时刻的累计值（第二轮的 1/1 还没发生）。
    const cp = messages.find((m) => m.event === 'checkpoint')?.data as RunCheckpointEvent;
    expect(cp.round).toBe(1);
    expect(cp.seq).toBe(3);
    expect(cp.deltas).toHaveLength(2);
    expect(cp.deltas.map((d) => d.role)).toEqual(['assistant', 'tool']);
    expect(cp.deltas[0].toolCalls?.map((c) => c.id)).toEqual(['c1']);
    expect(cp.deltas[1].toolCallId).toBe('c1');
    expect(cp.usage).toEqual([{ model: 'mock', input: 1, output: 1 }]);
  });

  it('非法 resume 返回 400 invalid_resume 且不写 SSE', async () => {
    const base = {
      round: 1,
      seq: 2,
      deltas: [{ role: 'assistant', content: '执行' }],
      usage: [{ model: 'mock', input: 1, output: 1 }],
    };
    const payloads = [
      // 顶层错型：字符串不是对象。
      'not-an-object',
      { ...base, round: -1 },
      { ...base, seq: 1.5 },
      { ...base, deltas: {} },
      { ...base, deltas: [{ role: 'user', content: 'x' }] },
      { ...base, deltas: [{ role: 'assistant', content: 42 }] },
      // tool 必须带非空 toolCallId，且必须能对上 assistant 的调用。
      { ...base, deltas: [{ role: 'tool', content: 'x' }] },
      { ...base, deltas: [{ role: 'tool', content: 'x', toolCallId: 'nope' }] },
      // 有调用没结果：不是完整轮落的断点。
      {
        ...base,
        deltas: [
          { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'n', args: {} }] },
        ],
      },
      // 角色错配：assistant 不能带 toolCallId，tool 不能带 toolCalls。
      { ...base, deltas: [{ role: 'assistant', content: 'x', toolCallId: 'c1' }] },
      {
        ...base,
        deltas: [
          { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'n', args: {} }] },
          {
            role: 'tool',
            content: 'x',
            toolCallId: 'c1',
            toolCalls: [{ id: 'c1', name: 'n', args: {} }],
          },
        ],
      },
      // toolCalls.args 必须是对象，不能是数组。
      {
        ...base,
        deltas: [
          { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'n', args: [] }] },
        ],
      },
      // 工具调用与结果之间插入 assistant：真实 provider 会拒绝这种历史。
      {
        ...base,
        deltas: [
          { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'n', args: {} }] },
          { role: 'assistant', content: '插队' },
          { role: 'tool', content: 'x', toolCallId: 'c1' },
        ],
      },
      // 超出逻辑序号上限（已为 Prisma Int 预留自增余量）。
      { ...base, seq: 2_000_000_001 },
      { ...base, usage: [{ model: '', input: 1, output: 1 }] },
      { ...base, usage: [{ model: 'm', input: -1, output: 0 }] },
      { ...base, usage: [{ model: 'm', input: '1', output: 0 }] },
    ];
    for (const resume of payloads) {
      const res = await postRuns({
        runId: 'r-bad',
        sessionId: 's1',
        goal: 'g',
        messages: [{ role: 'user', content: 'g' }],
        resume,
      });
      expect(res.status).toBe(400);
      // 必须在写 SSE 头之前拒绝，否则 BFF 会把错误当流式响应吞掉。
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'invalid_resume' });
    }
  });

  it('合法 resume 从 checkpoint 继续', async () => {
    const res = await postRuns({
      runId: 'r-resume',
      sessionId: 's1',
      goal: 'g',
      messages: [{ role: 'user', content: 'g' }],
      resume: {
        round: 1,
        seq: 9,
        deltas: [
          {
            role: 'assistant',
            content: '执行',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: '竞态' } }],
          },
          { role: 'tool', content: '{"results":[]}', toolCallId: 'c1' },
        ],
        usage: [{ model: 'mock', input: 5, output: 2 }],
      },
    });
    expect(res.status).toBe(200);
    const messages = decodeSseFrames(await res.text());
    // 脚本网关看到 tool 消息即收尾，因此只有一轮 think。
    expect(messages.map((m) => m.event)).toEqual(['step', 'usage', 'done']);
    const step = messages.find((m) => m.event === 'step')?.data as AgentEvent;
    expect(step.seq).toBe(9);
    expect(step.type).toBe('think');
    // 用量在 checkpoint 的 5/2 上累加本轮 1/1。
    expect(messages.find((m) => m.event === 'usage')?.data).toEqual({
      input: 6,
      output: 3,
      models: [{ model: 'mock', input: 6, output: 3 }],
    } satisfies UsageEvent);
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

  it('客户端断开后中止控制器，不再发起下一轮模型调用', async () => {
    // 注：网关接口不接收 signal，无法中断已在途的模型调用；这里验证的是
    // 调用返回后运行因 signal 已置位而停止后续轮次，且注册表不残留。
    const metrics = createRuntimeMetrics({ defaultMetrics: false });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gateway: ModelGateway = {
      async chat() {
        calls++;
        if (calls === 1) {
          await gate;
          return {
            content: '第一轮',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 1, output: 1 },
            model: 'mock',
          };
        }
        return { content: '第二轮', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
      },
    };
    const srv = createRuntimeServer({ gateway, tools: [echo], metrics });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const abort = new AbortController();
    const waitFor = async (text: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if ((await metrics.registry.metrics()).includes(text)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout waiting for ${text}`);
    };
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: 'r-close',
          sessionId: 's1',
          tenantId: 't1',
          userId: 'u1',
          goal: 'g',
          messages: [{ role: 'user', content: 'g' }],
        }),
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      await waitFor('ai_office_active_runs 1');
      abort.abort();
      // close 处理器收尾后活跃数归零，说明 abort 已生效。
      await waitFor('ai_office_active_runs 0');
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(1);
    } finally {
      release();
      abort.abort();
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

describe('任务/编码模式的兜底成果文件', () => {
  const answer = '# 上传接口实现\n\n已完成 UploadController。';

  async function runWithMode(mode: string, gateway: ModelGateway, tools: Tool[] = []) {
    const puts: { key: string; body: Buffer; contentType: string }[] = [];
    const storage: Storage = {
      ensureBucket: async () => {},
      putObject: async (key, body, contentType) => {
        puts.push({ key, body, contentType });
      },
      getObjectStream: async () => {
        throw new Error('unused');
      },
    };
    const server = createRuntimeServer({ gateway, tools, storage });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://127.0.0.1:${addr.port}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: 'r-fb',
          sessionId: 's1',
          tenantId: 't1',
          userId: 'u1',
          goal: 'g',
          messages: [{ role: 'user', content: 'g' }],
          mode,
        }),
      });
      const messages = decodeSseFrames(await res.text());
      const artifacts = messages
        .filter((m) => m.event === 'step')
        .map((m) => m.data as AgentEvent)
        .filter((ev) => ev.type === 'artifact');
      return { artifacts, puts };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  const plainGateway: ModelGateway = {
    async chat() {
      return { content: answer, toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
    },
  };

  it('任务模式没有任何产出时，把最终回答兜底保存为 任务结果.md', async () => {
    const { artifacts, puts } = await runWithMode('task', plainGateway);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payload).toMatchObject({ kind: 'text', filename: '任务结果.md' });
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^artifacts\/t1\/r-fb\/[0-9a-f-]{36}-任务结果\.md$/);
    expect(puts[0].contentType).toBe('text/plain; charset=utf-8');
    expect(puts[0].body.toString('utf8')).toBe(answer);
  });

  it('编码模式兜底文件名为 代码结果.md', async () => {
    const { artifacts } = await runWithMode('code', plainGateway);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payload).toMatchObject({ kind: 'text', filename: '代码结果.md' });
  });

  it('对话模式不强制产出成果文件', async () => {
    const { artifacts, puts } = await runWithMode('chat', plainGateway);
    expect(artifacts).toEqual([]);
    expect(puts).toEqual([]);
  });

  it('模型已经产出成果文件时不再追加兜底文件', async () => {
    const fileTool: Tool = {
      name: 'file.write',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return {
          artifact: {
            kind: 'text',
            filename: 'UploadController.java',
            storageKey: 'artifacts/t1/r-fb/x-UploadController.java',
            size: 10,
          },
        };
      },
    };
    let round = 0;
    const toolGateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '写文件',
            toolCalls: [{ id: 'c1', name: 'file.write', args: {} }],
            usage: { input: 1, output: 1 },
            model: 'mock',
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
      },
    };
    const { artifacts, puts } = await runWithMode('task', toolGateway, [fileTool]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payload).toMatchObject({ filename: 'UploadController.java' });
    // 兜底路径不会再写第二份对象。
    expect(puts).toEqual([]);
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

describe('POST /embed', () => {
  async function postEmbed(payload: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
  }

  it('批量向量化返回 vectors/dim/model', async () => {
    const res = await postEmbed({ texts: ['你好', '世界'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vectors: number[][];
      dim: number;
      model: string;
    };
    expect(body.vectors).toHaveLength(2);
    expect(body.dim).toBe(1024);
    expect(body.vectors[0]).toHaveLength(1024);
    expect(typeof body.model).toBe('string');
  });

  it('参数越界返回 400 invalid_params', async () => {
    expect((await postEmbed({ texts: [] })).status).toBe(400);
    expect((await postEmbed({ texts: ['a'.repeat(4001)] })).status).toBe(400);
    expect(
      (await postEmbed({ texts: Array.from({ length: 65 }, () => 'x') })).status,
    ).toBe(400);
  });

  it('注入的网关维度不符时返回 500 embedding_failed', async () => {
    const badServer = createRuntimeServer({
      gateway: scripted,
      tools: [echo],
      embedding: {
        dim: 3,
        model: 'bad',
        async embed(texts) {
          return texts.map(() => [1, 0]);
        },
      },
    });
    await new Promise<void>((r) => badServer.listen(0, r));
    const addr = badServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: ['x'] }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: 'embedding_failed' });
    } finally {
      await new Promise<void>((r) => badServer.close(() => r()));
    }
  });

  it('设置 AGENT_RUNTIME_TOKEN 后缺 token 返回 401', async () => {
    process.env.AGENT_RUNTIME_TOKEN = 'secret-tok';
    try {
      expect((await postEmbed({ texts: ['x'] })).status).toBe(401);
      const ok = await postEmbed(
        { texts: ['x'] },
        { 'x-agent-runtime-token': 'secret-tok' },
      );
      expect(ok.status).toBe(200);
      await ok.text();
    } finally {
      delete process.env.AGENT_RUNTIME_TOKEN;
    }
  });
});

