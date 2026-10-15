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
});
