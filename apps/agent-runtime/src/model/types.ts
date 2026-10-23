import type { ChatMessage, ModelModality } from '@ai-office/shared';

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
 * provider 无关的内容片段。文本附件在进入网关前已被抽成 text；
 * image/audio/video 保留原始字节（base64），由各协议适配器决定线格式。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: string }
  | { type: 'input_audio'; data: string; format: string }
  | { type: 'video_url'; videoUrl: string };

/**
 * 运行时内部的消息表示：在 ChatMessage（仅 role/content，用于持久化历史）之上补齐
 * OpenAI 兼容 function-calling 的往返字段——assistant 回合携带 toolCalls，tool 回合
 * 携带 toolCallId。缺了这两个字段，真实 provider 的多轮工具调用会被拒（400）。
 * parts 仅用于本次运行的多模态输入；content 始终保留可读文本，便于 Mock/日志/降级。
 */
export interface ModelMessage extends ChatMessage {
  toolCalls?: ToolCall[];
  toolCallId?: string;
  parts?: ContentPart[];
}

export interface ChatRequest {
  messages: ModelMessage[];
  tools: ToolSchema[];
  /** 本次运行允许的模型，按 BFF 给定优先级；缺省表示不限制。 */
  models?: string[];
  /** 本次消息实际携带的附件模态；路由据此跳过不支持的模型。 */
  requiredModalities?: ModelModality[];
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  /** 实际产出该响应的模型名，用于按模型归集用量。 */
  model: string;
}

/** 模型网关：M1 只暴露「一次 chat 补全」；多模型路由/限流/埋点留到 M5，不动上层。 */
export interface ModelGateway {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
