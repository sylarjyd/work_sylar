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
});
