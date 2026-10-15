import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

/**
 * 无 key 时的确定性回退：首轮发起一次 web.search，第二轮（已见 tool 结果）产出结论。
 * 让单测 / CI / 本地演示不依赖任何外部服务，同时保留完整的工具调用路径。
 */
export class MockGateway implements ModelGateway {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    const goal = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (!hasToolResult && goal) {
      return {
        content: `我需要先检索资料：${goal}`,
        toolCalls: [{ id: randomUUID(), name: 'web.search', args: { query: goal } }],
        usage: { input: 10, output: 8 },
      };
    }
    return {
      content: `根据检索结果，关于「${goal}」的结论已生成。`,
      toolCalls: [],
      usage: { input: 20, output: 12 },
    };
  }
}
