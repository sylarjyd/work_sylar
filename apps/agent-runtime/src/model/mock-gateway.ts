import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, ModelGateway, ModelMessage } from './types';

/**
 * 无 key 时的确定性回退：首轮发起一次 web.search，第二轮（已见 tool 结果）产出结论。
 * 让单测 / CI / 本地演示不依赖任何外部服务，同时保留完整的工具调用路径。
 */
export class MockGateway implements ModelGateway {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    // 多模态消息的正文在 parts 里；content 也保留了同样的文本，取任一即可。
    const goal = lastUser ? textOf(lastUser) : '';
    if (!hasToolResult && goal) {
      return {
        content: `我需要先检索资料：${goal}`,
        toolCalls: [{ id: randomUUID(), name: 'web.search', args: { query: goal } }],
        usage: { input: 10, output: 8 },
        model: 'mock',
      };
    }
    return {
      content: `根据检索结果，关于「${goal}」的结论已生成。`,
      toolCalls: [],
      usage: { input: 20, output: 12 },
      model: 'mock',
    };
  }
}

/** 只取文本片段；Mock 不理解图片/音频/视频，忽略媒体不会影响确定性回退。 */
function textOf(m: ModelMessage): string {
  if (!m.parts) return m.content;
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
}
