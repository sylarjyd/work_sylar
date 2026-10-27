import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAICompatGateway } from './openai-compat';

interface Stub {
  server: Server;
  baseUrl: string;
  lastBody: () => unknown;
}

function startStub(
  handle: (body: unknown, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<Stub> {
  let captured: unknown;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured = JSON.parse(raw || '{}');
      handle(captured, req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        lastBody: () => captured,
      });
    });
  });
}

let streamStub: Stub;
let jsonStub: Stub;

beforeAll(async () => {
  streamStub = await startStub((_body, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [
      { choices: [{ delta: { content: '你' } }] },
      // 混入 CRLF，验证行尾归一化不会漏帧。
      { choices: [{ delta: { content: '好' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  function: { name: 'web_search', arguments: '{"query":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } },
        ],
      },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } },
    ];
    res.write(
      chunks
        .map((c, i) => `data: ${JSON.stringify(c)}${i === 1 ? '\r\n\r\n' : '\n\n'}`)
        .join(''),
    );
    res.end('data: [DONE]\n\n');
  });

  jsonStub = await startStub((_body, _req, res) => {
    // 模拟忽略 stream 参数的 provider：直接回一次性 JSON。
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '整段回答', tool_calls: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
  });
});

afterAll(async () => {
  await new Promise<void>((r) => streamStub.server.close(() => r()));
  await new Promise<void>((r) => jsonStub.server.close(() => r()));
});

describe('OpenAICompatGateway 流式', () => {
  it('逐块回调正文，并累积 tool_calls 与 usage', async () => {
    const gw = new OpenAICompatGateway({
      baseUrl: streamStub.baseUrl,
      apiKey: 'k',
      model: 'deepseek-chat',
    });
    const deltas: string[] = [];
    const res = await gw.chat(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'web.search', description: 'd', parameters: {} }],
      },
      { onDelta: (text) => deltas.push(text) },
    );

    expect(deltas).toEqual(['你', '好']);
    expect(res.content).toBe('你好');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'web.search', args: { query: 'x' } }]);
    expect(res.usage).toEqual({ input: 3, output: 5 });
    expect((streamStub.lastBody() as { stream?: boolean }).stream).toBe(true);
    expect(
      (streamStub.lastBody() as { stream_options?: { include_usage?: boolean } }).stream_options,
    ).toEqual({ include_usage: true });
  });

  it('provider 忽略 stream 直接回 JSON 时仍按一次性补全返回', async () => {
    const gw = new OpenAICompatGateway({
      baseUrl: jsonStub.baseUrl,
      apiKey: 'k',
      model: 'deepseek-chat',
    });
    const deltas: string[] = [];
    const res = await gw.chat(
      { messages: [{ role: 'user', content: 'hi' }], tools: [] },
      { onDelta: (text) => deltas.push(text) },
    );

    expect(deltas).toEqual(['整段回答']);
    expect(res.content).toBe('整段回答');
    expect(res.usage).toEqual({ input: 1, output: 2 });
  });
});
