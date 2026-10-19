import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAICompatGateway } from './openai-compat';

/** 一个极简的 OpenAI 兼容桩服务：按注入的应答器返回固定 JSON，并捕获请求体。 */
function startStubServer(
  respond: (body: unknown) => { status: number; json: unknown },
): Promise<{ server: Server; baseUrl: string; lastBody: () => unknown }> {
  let captured: unknown;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured = JSON.parse(raw || '{}');
      const { status, json } = respond(captured);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((r) => {
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      r({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        lastBody: () => captured,
      });
    });
  });
}

let server: Server;
let baseUrl: string;
let lastBody: () => unknown;

beforeAll(async () => {
  const stub = await startStubServer(() => ({
    status: 200,
    json: {
      choices: [
        {
          message: {
            content: '好的',
            tool_calls: [
              {
                id: 'c1',
                function: { name: 'web.search', arguments: '{"query":"x"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    },
  }));
  server = stub.server;
  baseUrl = stub.baseUrl;
  lastBody = stub.lastBody;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('OpenAICompatGateway', () => {
  it('解析 content / tool_calls / usage', async () => {
    const gw = new OpenAICompatGateway({ baseUrl, apiKey: 'k', model: 'deepseek-chat' });
    const res = await gw.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

    expect(res.content).toBe('好的');
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'web.search', args: { query: 'x' } },
    ]);
    expect(res.usage).toEqual({ input: 3, output: 5 });
    expect(res.model).toBe('deepseek-chat');
  });

  it('把 ModelMessage 正确映射为 OpenAI 线格式（tool_calls / tool_call_id 往返）', async () => {
    const gw = new OpenAICompatGateway({ baseUrl, apiKey: 'k', model: 'deepseek-chat' });
    await gw.chat({
      messages: [
        {
          role: 'assistant',
          content: '先搜索',
          toolCalls: [{ id: 'c1', name: 'web.search', args: { query: '竞品' } }],
        },
        { role: 'tool', content: '{"results":[]}', toolCallId: 'c1' },
      ],
      tools: [{ name: 'web.search', description: 'search', parameters: { type: 'object' } }],
    });

    const body = lastBody() as {
      messages: Record<string, unknown>[];
      tools?: unknown[];
    };

    expect(body.messages[0].tool_calls).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"竞品"}' },
      },
    ]);
    expect(body.messages[1].tool_call_id).toBe('c1');
  });

  it('发给 provider 的 tools[].function.name 转成下划线（wire 安全），不出现点号', async () => {
    const gw = new OpenAICompatGateway({ baseUrl, apiKey: 'k', model: 'deepseek-chat' });
    await gw.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'web.search', description: 's', parameters: { type: 'object' } },
        { name: 'web.fetch', description: 'f', parameters: { type: 'object' } },
      ],
    });

    const body = lastBody() as { tools: { function: { name: string } }[] };
    expect(body.tools.map((t) => t.function.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('provider 回传的 wire 名 web_search 被映射回逻辑名 web.search', async () => {
    const stub = await startStubServer(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'c9', function: { name: 'web_search', arguments: '{"query":"x"}' } },
              ],
            },
          },
        ],
      },
    }));
    try {
      const gw = new OpenAICompatGateway({
        baseUrl: stub.baseUrl,
        apiKey: 'k',
        model: 'deepseek-chat',
      });
      const res = await gw.chat({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'web.search', description: 's', parameters: { type: 'object' } }],
      });
      expect(res.toolCalls[0].name).toBe('web.search');
    } finally {
      await new Promise<void>((r) => stub.server.close(() => r()));
    }
  });

  it('provider 回传未知（幻觉）名字时按原样透传，不误映射', async () => {
    const gw = new OpenAICompatGateway({ baseUrl, apiKey: 'k', model: 'deepseek-chat' });
    // 桩固定返回 web.search；此处仅声明 web.fetch，故不在反向表内，应原样透传。
    const res = await gw.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'web.fetch', description: 'f', parameters: { type: 'object' } }],
    });
    expect(res.toolCalls[0].name).toBe('web.search');
  });

  it('非 2xx 响应以 model_http_<status> 抛错', async () => {
    const bad = await startStubServer(() => ({ status: 500, json: { error: 'boom' } }));
    try {
      const gw = new OpenAICompatGateway({
        baseUrl: bad.baseUrl,
        apiKey: 'k',
        model: 'deepseek-chat',
      });
      await expect(
        gw.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      ).rejects.toThrow('model_http_500');
    } finally {
      await new Promise<void>((r) => bad.server.close(() => r()));
    }
  });

  it('2xx 但响应体非法 JSON 时以 model_bad_json 抛错', async () => {
    const bad = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    });
    await new Promise<void>((r) => bad.listen(0, () => r()));
    const addr = bad.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const gw = new OpenAICompatGateway({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'k',
        model: 'deepseek-chat',
      });
      await expect(
        gw.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      ).rejects.toThrow('model_bad_json');
    } finally {
      await new Promise<void>((r) => bad.close(() => r()));
    }
  });

  it('tools 为空时请求体不含 tools 键', async () => {
    const gw = new OpenAICompatGateway({ baseUrl, apiKey: 'k', model: 'deepseek-chat' });
    await gw.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

    const body = lastBody() as Record<string, unknown>;
    expect('tools' in body).toBe(false);
  });
});
