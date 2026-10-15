import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, type Server } from 'node:http';
import { AppModule } from '../app.module';
import { CORS_OPTIONS } from '../cors';
import { encodeSse, decodeSseFrames } from '@ai-office/shared';

let upstream: Server;
let upstreamUrl: string;
let app: NestFastifyApplication;
let baseUrl: string;

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
  // 与 main.ts 保持一致：漏掉 enableCors 会让下面的 CORS 用例失去意义。
  app.enableCors(CORS_OPTIONS);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // 真实监听一个端口：app.inject() 直接调路由处理器、不经过 HTTP/中间件栈，
  // 因此"响应头缺失"这类问题只有走真实 socket 才能暴露。
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
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

  it('真实 HTTP 下响应带 CORS 头，事件流可被浏览器端读取', async () => {
    const res = await fetch(`${baseUrl}/api/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ goal: '写周报' }),
    });
    // 控制器为了自己写裸 socket 而 hijack 了回复，若不同步 Fastify 已累积的
    // 响应头，CORS 头就会只存在于中间件内部、永远到不了浏览器。
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const messages = decodeSseFrames(await res.text());
    expect(messages.map((m) => m.event)).toEqual(['step', 'step', 'done']);
  });
});
