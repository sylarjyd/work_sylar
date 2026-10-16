import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { decodeSseFrames, createSseParser } from '@ai-office/shared';
import type { AgentEvent } from '@ai-office/shared';
import { createRuntimeServer } from './server';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';

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
    expect(messages.map((m) => m.event)).toEqual(['step', 'step', 'step', 'step', 'usage', 'done']);
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
          return { content: 'hi', toolCalls: [], usage: { input: 0, output: 0 } };
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
        body: JSON.stringify({ runId: 'r', sessionId: 's', tenantId: 't', goal: 'g', messages: [] }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
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
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 0, output: 0 } };
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
