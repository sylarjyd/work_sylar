import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAICompatEmbeddingGateway } from './openai-compat-embedding';

let upstream: Server;
let baseUrl: string;
let lastBody: unknown;
let status = 200;
let response = JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastBody = JSON.parse(body || '{}');
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(response);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  status = 200;
  lastBody = undefined;
  response = JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
});

describe('OpenAICompatEmbeddingGateway', () => {
  it('POST /embeddings，体含 model 与 input', async () => {
    const gw = new OpenAICompatEmbeddingGateway({ baseUrl, apiKey: 'k', model: 'm', dim: 2 });
    await gw.embed(['甲', '乙']);
    expect(lastBody).toEqual({ model: 'm', input: ['甲', '乙'] });
  });

  it('按 index 排序返回，维度取响应', async () => {
    const gw = new OpenAICompatEmbeddingGateway({ baseUrl, apiKey: 'k', model: 'm', dim: 2 });
    const out = await gw.embed(['a', 'b']);
    expect(out).toEqual([[1, 0], [0, 1]]);
  });

  it('非 2xx 抛 embedding_http_<status>', async () => {
    status = 500;
    const gw = new OpenAICompatEmbeddingGateway({ baseUrl, apiKey: 'k', model: 'm', dim: 1024 });
    await expect(gw.embed(['a'])).rejects.toThrow('embedding_http_500');
  });

  it('返回维度与 EMBEDDING_DIM 不符抛 embedding_dim_mismatch', async () => {
    response = JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] });
    const gw = new OpenAICompatEmbeddingGateway({ baseUrl, apiKey: 'k', model: 'm', dim: 2 });
    await expect(gw.embed(['a'])).rejects.toThrow('embedding_dim_mismatch');
  });
});
