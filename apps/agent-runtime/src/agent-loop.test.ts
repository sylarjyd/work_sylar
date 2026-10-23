import { describe, it, expect } from 'vitest';
import { runAgent, type ToolObservation } from './agent-loop';
import type { ModelGateway } from './model/types';
import type { Tool } from './tools/types';
import type { ConfirmGate } from './confirm/broker';
import type { AgentEvent, RunRequest, UsageEvent } from '@ai-office/shared';

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
  permission: 'safe',
  async execute(args) {
    return { results: [{ title: 'T', url: 'u', snippet: String(args.query) }] };
  },
};

const req: RunRequest = {
  runId: 'r1',
  sessionId: 's1',
  tenantId: 't1',
  userId: 'u1',
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
            usage: { input: 1, output: 1 }, model: 'mock',
          };
        }
        return { content: '结论', toolCalls: [], usage: { input: 2, output: 2 }, model: 'mock' };
      },
    };
    const usages: { input: number; output: number }[] = [];
    const events = await collect(
      runAgent(req, { gateway, tools: [echoTool], onUsage: (u) => usages.push(u) }),
    );
    expect(events.map((e) => e.type)).toEqual(['think', 'tool_call', 'tool_result', 'think']);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(usages).toEqual([
      { input: 3, output: 3, models: [{ model: 'mock', input: 3, output: 3 }] },
    ]);
  });

  it('模型调用中途抛错时仍上报已产生的用量', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '先搜索',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 1, output: 0 }, model: 'mock',
          };
        }
        throw new Error('boom');
      },
    };
    const usages: UsageEvent[] = [];
    const gen = runAgent(req, { gateway, tools: [echoTool], onUsage: (u) => usages.push(u) });
    // 手动消费：collect helper 在异常时会直接向上抛，无法在此断言 finally 的上报。
    await expect(
      (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('boom');
    expect(usages).toEqual([
      { input: 1, output: 0, models: [{ model: 'mock', input: 1, output: 0 }] },
    ]);
  });

  it('超出积分预算时发 notice 并停止，且不再调用模型', async () => {
    let calls = 0;
    const gateway: ModelGateway = {
      async chat() {
        calls++;
        return {
          content: '继续',
          toolCalls: [{ id: 'c', name: 'web.search', args: { query: 'x' } }],
          usage: { input: 1000, output: 0 },
          model: 'mock',
        };
      },
    };
    const events = await collect(
      runAgent(req, {
        gateway,
        tools: [echoTool],
        billing: {
          maxCredits: 1,
          allowedModels: ['mock'],
          prices: { mock: { inputMilliCreditsPer1k: 2000, outputMilliCreditsPer1k: 0 } },
        },
      }),
    );
    expect(calls).toBe(1);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice?.payload).toMatchObject({ code: 'budget_exceeded' });
  });

  it('无工具调用即结束（单轮）', async () => {
    const gateway: ModelGateway = {
      async chat() {
        return { content: '直接回答', toolCalls: [], usage: { input: 1, output: 1 }, model: 'mock' };
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
          usage: { input: 1, output: 1 }, model: 'mock',
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
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const undefinedTool: Tool = {
      name: 'web.search',
      description: 'd',
      parameters: {},
      permission: 'safe',
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
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const badTool: Tool = {
      name: 'boom',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        throw new Error('kaboom');
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [badTool] }));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.payload.ok).toBe(false);
  });

  it('把运行上下文透传给工具 execute', async () => {
    let seen: unknown;
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '调用',
            toolCalls: [{ id: 'c1', name: 'web.search', args: { query: 'x' } }],
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const spyTool: Tool = {
      name: 'web.search',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute(_args, ctx) {
        seen = ctx;
        return { results: [] };
      },
    };
    await collect(runAgent(req, { gateway, tools: [spyTool] }));
    expect(seen).toEqual({ tenantId: 't1', userId: 'u1', sessionId: 's1', runId: 'r1' });
  });

  it('工具结果含 artifact 时额外产出一条 artifact step', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '生成',
            toolCalls: [{ id: 'c1', name: 'doc.pptx', args: { filename: 'a.pptx' } }],
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const docTool: Tool = {
      name: 'doc.pptx',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return { artifact: { kind: 'pptx', filename: 'a.pptx', storageKey: 'k', size: 3 } };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [docTool] }));
    expect(events.map((e) => e.type)).toEqual([
      'think',
      'tool_call',
      'tool_result',
      'artifact',
      'think',
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    const art = events.find((e) => e.type === 'artifact');
    expect(art?.payload).toMatchObject({ kind: 'pptx', filename: 'a.pptx', storageKey: 'k', size: 3 });
  });

  it('工具失败时即使结果里有 artifact 也不产出 artifact step', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '生成',
            toolCalls: [{ id: 'c1', name: 'doc.pptx', args: {} }],
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const badTool: Tool = {
      name: 'doc.pptx',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        throw new Error('upload_failed');
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [badTool] }));
    expect(events.some((e) => e.type === 'artifact')).toBe(false);
  });

  it('artifact 字段为数组时不产出 artifact step', async () => {
    let round = 0;
    const gateway: ModelGateway = {
      async chat() {
        round++;
        if (round === 1) {
          return {
            content: '生成',
            toolCalls: [{ id: 'c1', name: 'doc.pptx', args: {} }],
            usage: { input: 0, output: 0 }, model: 'mock',
          };
        }
        return { content: '完成', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
      },
    };
    const weirdTool: Tool = {
      name: 'doc.pptx',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return { artifact: [] };
      },
    };
    const events = await collect(runAgent(req, { gateway, tools: [weirdTool] }));
    expect(events.some((e) => e.type === 'artifact')).toBe(false);
  });

  it('confirm 工具：先出 confirm_request，放行后执行并回填 approved', async () => {
    let executed = false;
    const tool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        executed = true;
        return { stdout: 'sandbox-ok' };
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'code.exec', args: { code: '1+1' } });
    const events = await collect(runAgent(req, { gateway, tools: [tool], confirm: stubGate(true) }));

    expect(events.map((e) => e.type)).toEqual([
      'think',
      'tool_call',
      'confirm_request',
      'tool_result',
      'think',
    ]);
    const cr = events.find((e) => e.type === 'confirm_request')!;
    expect(typeof cr.payload.confirmId).toBe('string');
    expect(cr.payload).toMatchObject({ tool: 'code.exec', args: { code: '1+1' } });
    const tr = events.find((e) => e.type === 'tool_result')!;
    expect(tr.payload).toMatchObject({ tool: 'code.exec', ok: true, approved: true });
    expect(executed).toBe(true);
  });

  it('confirm 工具：拒绝则不执行，回填 denied', async () => {
    let executed = false;
    const tool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        executed = true;
        return { stdout: 'never' };
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'code.exec', args: {} });
    const events = await collect(runAgent(req, { gateway, tools: [tool], confirm: stubGate(false) }));

    const tr = events.find((e) => e.type === 'tool_result')!;
    expect(tr.payload).toMatchObject({ ok: false, denied: true, reason: 'user_denied' });
    expect(executed).toBe(false);
  });

  it('confirm 工具：超时回填 reason=confirm_timeout', async () => {
    const tool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        return { stdout: 'never' };
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'code.exec', args: {} });
    const events = await collect(
      runAgent(req, { gateway, tools: [tool], confirm: stubGate(false, 'confirm_timeout') }),
    );
    const tr = events.find((e) => e.type === 'tool_result')!;
    expect(tr.payload).toMatchObject({ ok: false, denied: true, reason: 'confirm_timeout' });
  });

  it('confirm 工具：未注入闸门时 fail-safe 拒绝，不执行', async () => {
    let executed = false;
    const tool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        executed = true;
        return { stdout: 'never' };
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'code.exec', args: {} });
    // 不传 confirm：老调用方（如既有单测）不应被静默放行。
    const events = await collect(runAgent(req, { gateway, tools: [tool] }));
    const tr = events.find((e) => e.type === 'tool_result')!;
    expect(tr.payload).toMatchObject({ ok: false, denied: true, reason: 'user_denied' });
    expect(executed).toBe(false);
  });

  it('blocked 工具：不执行，回填 blocked', async () => {
    let executed = false;
    const tool: Tool = {
      name: 'danger',
      description: 'd',
      parameters: {},
      permission: 'blocked',
      async execute() {
        executed = true;
        return {};
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'danger', args: {} });
    const events = await collect(runAgent(req, { gateway, tools: [tool] }));
    const tr = events.find((e) => e.type === 'tool_result')!;
    expect(tr.payload).toMatchObject({ ok: false, blocked: true });
    expect(executed).toBe(false);
  });

  it('工具结果含 display 时原样透传到 tool_result（超过 500 字也不截断）', async () => {
    const big = 'x'.repeat(2000);
    const tool: Tool = {
      name: 'kb.retrieve',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return {
          ok: true,
          tool: 'kb.retrieve',
          text: big,
          display: { sources: [{ docName: 'a', seq: 1, score: 0.9, snippet: big }] },
        };
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'kb.retrieve', args: { query: 'x' } });
    const events = await collect(runAgent(req, { gateway, tools: [tool] }));
    const tr = events.find((e) => e.type === 'tool_result')!;
    // preview 被截断…
    expect(tr.payload.preview).toMatchObject({ truncated: true });
    // …但 display 完整保留。
    expect((tr.payload.display as { sources: unknown[] }).sources).toHaveLength(1);
    expect(
      (tr.payload.display as { sources: { snippet: string }[] }).sources[0].snippet,
    ).toHaveLength(2000);
  });

  it('工具结果无 display 字段时不注入 display', async () => {
    const tool: Tool = {
      name: 'web.search',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return { results: [] };
      },
    };
    const gateway = oneShotGateway({ id: 'c1', name: 'web.search', args: { query: 'x' } });
    const events = await collect(runAgent(req, { gateway, tools: [tool] }));
    const tr = events.find((e) => e.type === 'tool_result')!;
    expect('display' in tr.payload).toBe(false);
  });

  it('工具结果映射为 ok/error/blocked 观测，code.exec 超时单独标记', async () => {
    const failed: ToolObservation[] = [];
    const timeoutTool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'safe',
      async execute() {
        return { ok: false, timeout: true, stdout: '', stderr: '', durationMs: 5 };
      },
    };
    await collect(
      runAgent(req, {
        gateway: oneShotGateway({ id: 'c1', name: 'code.exec', args: {} }),
        tools: [timeoutTool],
        onToolCall: (o) => failed.push(o),
      }),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      tool: 'code.exec',
      status: 'error',
      codeExecTimeout: true,
    });

    const blocked: ToolObservation[] = [];
    const blockedTool: Tool = {
      name: 'danger',
      description: 'd',
      parameters: {},
      permission: 'blocked',
      async execute() {
        return {};
      },
    };
    await collect(
      runAgent(req, {
        gateway: oneShotGateway({ id: 'c2', name: 'danger', args: {} }),
        tools: [blockedTool],
        onToolCall: (o) => blocked.push(o),
      }),
    );
    expect(blocked[0]).toMatchObject({ tool: 'danger', status: 'blocked', codeExecTimeout: false });
  });

  it('被拒绝的 confirm 工具记为 denied', async () => {
    const seen: ToolObservation[] = [];
    const tool: Tool = {
      name: 'code.exec',
      description: 'd',
      parameters: {},
      permission: 'confirm',
      async execute() {
        return { stdout: 'never' };
      },
    };
    await collect(
      runAgent(req, {
        gateway: oneShotGateway({ id: 'c1', name: 'code.exec', args: {} }),
        tools: [tool],
        confirm: stubGate(false),
        onToolCall: (o) => seen.push(o),
      }),
    );
    expect(seen[0]).toMatchObject({ status: 'denied', codeExecTimeout: false });
  });
});

/** 第一轮发起一次工具调用、第二轮收尾的桩网关。 */
function oneShotGateway(call: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): ModelGateway {
  let round = 0;
  return {
    async chat() {
      round++;
      if (round === 1) {
        return { content: '执行', toolCalls: [call], usage: { input: 0, output: 0 }, model: 'mock' };
      }
      return { content: '收尾', toolCalls: [], usage: { input: 0, output: 0 }, model: 'mock' };
    },
  };
}

/** 立即兑现的桩闸门，避免测试里真的挂起。 */
function stubGate(approved: boolean, reason?: 'user_denied' | 'confirm_timeout'): ConfirmGate {
  return {
    request: async () =>
      approved ? { approved: true } : { approved: false, reason: reason ?? 'user_denied' },
    resolve: () => false,
    cancel: () => {},
  };
}

describe('runAgent ģ��ѡ��', () => {
  it('selectedModel �ŵ�һ��think �¼���ʵ��ģ��', async () => {
    let seen: string[] | undefined;
    const gateway: ModelGateway = {
      async chat(req) {
        seen = req.models;
        return { content: '�õ�', toolCalls: [], usage: { input: 1, output: 1 }, model: req.models?.[0] ?? 'x' };
      },
    };
    const events = await collect(
      runAgent(req, {
        gateway,
        tools: [],
        billing: {
          maxCredits: 10,
          allowedModels: ['a', 'b', 'c'],
          selectedModel: 'b',
          prices: {
            a: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
            b: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
            c: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
          },
        },
      }),
    );
    expect(seen).toEqual(['b', 'a', 'c']);
    expect(events[0].payload).toMatchObject({ text: '�õ�', model: 'b' });
  });

  it('û�� selectedModel ʱ���� allowedModels ԭ˳��', async () => {
    let seen: string[] | undefined;
    const gateway: ModelGateway = {
      async chat(req) {
        seen = req.models;
        return { content: 'ok', toolCalls: [], usage: { input: 1, output: 1 }, model: 'a' };
      },
    };
    await collect(
      runAgent(req, {
        gateway,
        tools: [],
        billing: {
          maxCredits: 10,
          allowedModels: ['a', 'b'],
          prices: {
            a: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
            b: { inputMilliCreditsPer1k: 1, outputMilliCreditsPer1k: 1 },
          },
        },
      }),
    );
    expect(seen).toEqual(['a', 'b']);
  });
});
