import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createGateway } from './create-gateway';
import { MockGateway } from './mock-gateway';
import { OpenAICompatGateway } from './openai-compat';

describe('createGateway', () => {
  it('无 DEEPSEEK_API_KEY 时回退 MockGateway', () => {
    expect(createGateway({})).toBeInstanceOf(MockGateway);
  });

  it('有 key 时使用 OpenAI 兼容 provider', () => {
    expect(createGateway({ DEEPSEEK_API_KEY: 'k' })).toBeInstanceOf(OpenAICompatGateway);
  });

  it('MODEL_PROVIDERS 配置有效 key 时返回 RoutingGateway', () => {
    const gw = createGateway({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'deepseek-chat', baseUrl: 'https://x/v1', apiKeyEnv: 'K1' },
      ]),
      K1: 'sk-1',
    } as NodeJS.ProcessEnv);
    expect(gw.constructor.name).toBe('RoutingGateway');
  });

  it('MODEL_PROVIDERS 非法 JSON 时启动失败', () => {
    expect(() => createGateway({ MODEL_PROVIDERS: '{bad' } as NodeJS.ProcessEnv)).toThrow(
      'invalid_MODEL_PROVIDERS',
    );
  });

  it('MODEL_PROVIDERS 字段为空或模型重复时启动失败', () => {
    expect(() =>
      createGateway({
        MODEL_PROVIDERS: JSON.stringify([{ model: '', baseUrl: 'https://x/v1', apiKeyEnv: 'K' }]),
        K: 'sk-1',
      } as NodeJS.ProcessEnv),
    ).toThrow('invalid_MODEL_PROVIDERS');
    expect(() =>
      createGateway({
        MODEL_PROVIDERS: JSON.stringify([
          { model: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: 'https://y/v1', apiKeyEnv: 'K' },
        ]),
        K: 'sk-1',
      } as NodeJS.ProcessEnv),
    ).toThrow('invalid_MODEL_PROVIDERS');
  });

  it('MODEL_BASE_URL / MODEL_NAME 覆盖生效（打到 <base>/chat/completions 且带 model 名）', async () => {
    let path = '';
    let body: { model?: string } = {};
    const server = createServer((req, res) => {
      path = req.url ?? '';
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const gw = createGateway({
        DEEPSEEK_API_KEY: 'k',
        MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
        MODEL_NAME: 'm2',
      });
      expect(gw).toBeInstanceOf(OpenAICompatGateway);
      await gw.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

      expect(path).toBe('/v1/chat/completions');
      expect(body.model).toBe('m2');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
