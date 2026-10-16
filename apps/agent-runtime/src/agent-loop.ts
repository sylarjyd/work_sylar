import type { AgentEvent, RunRequest } from '@ai-office/shared';
import type { ModelGateway, ModelMessage } from './model/types';
import type { RunContext, Tool } from './tools/types';

export interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;
  onUsage?: (usage: { input: number; output: number }) => void;
}

const DEFAULT_MAX_ROUNDS = 8;

/**
 * plan → act → observe 循环（上游 §5.1 的 M1 精简实现）。
 * 每次模型返回无 tool_call 即结束；受 maxRounds 上限保护，防失控。
 */
export async function* runAgent(req: RunRequest, deps: RunDeps): AsyncGenerator<AgentEvent> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const schemas = deps.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const messages: ModelMessage[] = [...req.messages];
  const ctx: RunContext = {
    tenantId: req.tenantId,
    sessionId: req.sessionId,
    runId: req.runId,
  };
  let seq = 0;
  let usage = { input: 0, output: 0 };
  const step = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
    runId: req.runId,
    seq: seq++,
    type,
    payload,
    ts: Date.now(),
  });

  // 注：M1 下耗尽 maxRounds 会静默结束（客户端只看到 done），
  // “轮次耗尽”这一信号留待后续里程碑；此处不新增事件、不改变输出契约。
  for (let round = 0; round < maxRounds; round++) {
    const resp = await deps.gateway.chat({ messages, tools: schemas });
    usage = { input: usage.input + resp.usage.input, output: usage.output + resp.usage.output };

    if (resp.content) {
      yield step('think', { text: resp.content });
    }
    if (resp.toolCalls.length === 0) {
      // 无工具调用即结束；回填最终 assistant 文本以保持历史完整。
      if (resp.content) messages.push({ role: 'assistant', content: resp.content });
      break;
    }

    // 有工具调用：assistant 回合必须回带 toolCalls、tool 回合回带 toolCallId，
    // 否则真实 provider（DeepSeek/OpenAI 兼容）的多轮 function-calling 会被拒。
    messages.push({ role: 'assistant', content: resp.content, toolCalls: resp.toolCalls });
    for (const call of resp.toolCalls) {
      yield step('tool_call', { tool: call.name, args: call.args });
      const tool = deps.tools.find((t) => t.name === call.name);
      let ok = true;
      let result: unknown;
      try {
        if (!tool) throw new Error(`unknown_tool:${call.name}`);
        result = await tool.execute(call.args, ctx);
      } catch (err) {
        ok = false;
        result = { error: String(err) };
      }
      yield step('tool_result', { tool: call.name, ok, preview: preview(result) });
      // 工具结果回填进对话，供下一轮模型使用（截断防上下文爆炸）。
      messages.push({
        role: 'tool',
        content: (JSON.stringify(result) ?? 'null').slice(0, 4000),
        toolCallId: call.id,
      });
    }
  }

  deps.onUsage?.(usage);
}

function preview(value: unknown): unknown {
  const s = JSON.stringify(value) ?? 'null';
  return s.length > 500 ? { truncated: true, text: s.slice(0, 500) } : value;
}
