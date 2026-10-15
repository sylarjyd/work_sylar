import type { ChatMessage } from '@ai-office/shared';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * 运行时内部的消息表示：在 ChatMessage（仅 role/content，用于持久化历史）之上补齐
 * OpenAI 兼容 function-calling 的往返字段——assistant 回合携带 toolCalls，tool 回合
 * 携带 toolCallId。缺了这两个字段，真实 provider 的多轮工具调用会被拒（400）。
 */
export interface ModelMessage extends ChatMessage {
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatRequest {
  messages: ModelMessage[];
  tools: ToolSchema[];
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}

/** 模型网关：M1 只暴露「一次 chat 补全」；多模型路由/限流/埋点留到 M5，不动上层。 */
export interface ModelGateway {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
