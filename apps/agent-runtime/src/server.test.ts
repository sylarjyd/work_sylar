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
