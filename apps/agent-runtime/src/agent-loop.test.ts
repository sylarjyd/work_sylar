import { describe, it, expect } from 'vitest';
import { runAgent } from './agent-loop';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';
import type { AgentEvent, RunRequest } from '@ai-office/shared';

function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  return (async () => {
    const out: AgentEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  })();
}

const echoTool: Tool = {
  name: 'web.search',
  description: 'd',
  parameters: {},
  async execute(args) {
    return { results: [{ title: 'T', url: 'u', snippet: String(args.query) }] };
  },
};

const req: RunRequest = {
  runId: 'r1',
  sessionId: 's1',
  goal: '查竞品',
  messages: [{ role: 'user', content: '查竞品' }],
};

describe('runAgent', () => {
  it('调工具一轮后结束，产出 think/tool_call/tool_result', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '先搜索',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: '竞品' } }],
            usage: { input: 1, output: 1 },
          };
        }
        return { content: '结论', toolCalls: [], usage: { input: 2, output: 2 } };
      },
    };
    const usages: { input: number; output: number }[] = [];
    const events = await collect(
      runAgent(req, { gateway, tools: [echoTool], onUsage: (u) => usages.push(u) }),
    );
    expect(events.map((e) => e.type)).toEqual(['think', 'tool_call', 'tool_result', 'think']);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(usages).toEqual([{ input: 3, output: 3 }]);
  });

  it('无工具调用即结束（单轮）', async () => {
    const gateway: ModelGateway = {
      async chat() {
        return { content: '直接回答', toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [] }));
    expect(events.map((e) => e.type)).toEqual(['think']);
  });

  it('达到轮次上限后停止', async () => {
    const gateway: ModelGateway = {
      async chat() {
        return {
          content: '继续',
          toolCalls: [{ id: 'c', name: 'web.search', args: { query: 'x' } }],
          usage: { input: 1, output: 1 },
        };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [echoTool], maxRounds: 2 }));
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
    // 2 轮 × [think, tool_call, tool_result] = 6 个事件，且以 tool_result 收尾，
    // 说明是被轮次上限截停、而不是因“无 tool_call”提前 break。
    expect(events).toHaveLength(6);
    expect(events[events.length - 1].type).toBe('tool_result');
  });

  it('工具返回 undefined 不中断运行', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '搜一下',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 } };
      },
    };
    const undefinedTool: Tool = {
      name: 'web.search',
      description: 'd',
      parameters: {},
      async execute() {
        return undefined;
      },
    };
    // 若 JSON.stringify(undefined) 未被守护，这里会抛 TypeError 使生成器中断。
    const events = await collect(runAgent(req, { gateway, tools: [undefinedTool] }));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.payload.ok).toBe(true);
  });

  it('工具报错不中断循环，记为失败结果', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '试试',
            toolCalls: [{ id: 'c1', name: 'boom', args: {} }],
            usage: { input: 0, output: 0 },
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 } };
      },
    };
    const badTool: Tool = {
      name: 'boom',
      description: 'd',
      parameters: {},
      async execute() {
        throw new Error('kaboom');
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [badTool] }));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.payload.ok).toBe(false);
  });
});
