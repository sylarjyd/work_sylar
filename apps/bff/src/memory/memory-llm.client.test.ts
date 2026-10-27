import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunModelRoute } from '@ai-office/shared';
import { MemoryLlmClient, parseFacts, sanitizeSummary } from './memory-llm.client';

const route = {
  model: 'm1',
  baseUrl: 'http://model.local/v1',
  apiKey: 'k1',
} as RunModelRoute;

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MemoryLlmClient.summarize', () => {
  it('请求包含旧摘要与新增对话，输出裁剪到 2000 字并去掉代码围栏', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatResponse('```\n' + '摘'.repeat(2500) + '\n```'));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await new MemoryLlmClient().summarize(
      route,
      [{ role: 'user', content: '你好', attachments: [] }],
      '旧摘要',
    );

    expect(summary).not.toBeNull();
    expect(Array.from(summary!).length).toBe(2000);
    expect(summary!.startsWith('摘')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://model.local/v1/chat/completions');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(400);
    expect(body.messages[1].content).toContain('【已有摘要】');
    expect(body.messages[1].content).toContain('旧摘要');
    expect(body.messages[1].content).toContain('用户: 你好');
  });

  it('模型失败时返回 null，不抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    );
    const summary = await new MemoryLlmClient().summarize(route, [
      { role: 'user', content: 'x', attachments: [] },
    ]);
    expect(summary).toBeNull();
  });

  it('网络异常同样返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(
      new MemoryLlmClient().summarize(route, [{ role: 'user', content: 'x', attachments: [] }]),
    ).resolves.toBeNull();
  });
});

describe('MemoryLlmClient.extractFacts', () => {
  it('解析 JSON 数组并截断到 3 条', async () => {
    const facts = ['喜欢简洁', '在成都工作', '目标做自动化', '多余'];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(chatResponse(JSON.stringify(facts))),
    );
    await expect(
      new MemoryLlmClient().extractFacts(route, '问题', '回答'),
    ).resolves.toEqual(['喜欢简洁', '在成都工作', '目标做自动化']);
  });

  it('模型失败返回空数组', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(new MemoryLlmClient().extractFacts(route, 'q', 'a')).resolves.toEqual([]);
  });
});

describe('parseFacts / sanitizeSummary', () => {
  it('容忍代码围栏与前后说明文字', () => {
    expect(parseFacts('```json\n["a","b"]\n```')).toEqual(['a', 'b']);
    expect(parseFacts('结果如下：["a"]')).toEqual(['a']);
    expect(parseFacts('不是 JSON')).toEqual([]);
  });

  it('单条事实去空白、去重并限制 500 字', () => {
    const long = '字'.repeat(600);
    expect(parseFacts(JSON.stringify([long, long, ' 重复 ']))).toEqual([
      '字'.repeat(500),
      '重复',
    ]);
  });

  it('摘要去掉包裹的引号', () => {
    expect(sanitizeSummary('“摘要内容”')).toBe('摘要内容');
    expect(sanitizeSummary('“摘要内容”\n')).toBe('摘要内容');
    expect(sanitizeSummary('```\n摘要内容\n```')).toBe('摘要内容');
  });
});
