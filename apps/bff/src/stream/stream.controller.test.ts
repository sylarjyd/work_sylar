import 'reflect-metadata';
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

  it('上游不可达时返回 502', async () => {
    // 借一个已释放的端口来制造"连接被拒"：监听拿到端口号后立刻关掉。
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, r));
    const addr = dead.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const deadUrl = `http://127.0.0.1:${addr.port}`;
    await new Promise<void>((r) => dead.close(() => r()));

    process.env.AGENT_RUNTIME_URL = deadUrl;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/stream',
        payload: { goal: '写周报' },
      });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.payload)).toEqual({ error: 'upstream_unreachable' });
    } finally {
      process.env.AGENT_RUNTIME_URL = upstreamUrl;
    }
  });

  it('上游非 2xx 时原样透传状态码与响应体', async () => {
    const failing = createServer((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_goal' }));
    });
    await new Promise<void>((r) => failing.listen(0, r));
    const addr = failing.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');

    process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/stream',
        payload: { goal: '写周报' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'bad_goal' });
    } finally {
      process.env.AGENT_RUNTIME_URL = upstreamUrl;
      await new Promise<void>((r) => failing.close(() => r()));
    }
  });
});
