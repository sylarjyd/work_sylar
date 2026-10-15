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
});
