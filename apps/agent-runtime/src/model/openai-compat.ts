import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, ModelGateway, ModelMessage } from './types';

interface OpenAIResponse {
  choices?: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 走 OpenAI 兼容的 /chat/completions（DeepSeek 即此协议）。 */
export class OpenAICompatGateway implements ModelGateway {
  constructor(private readonly cfg: OpenAICompatConfig) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: req.messages.map(toWireMessage),
        tools: req.tools.length
          ? req.tools.map((t) => ({ type: 'function', function: t }))
          : undefined,
      }),
    });
    if (!res.ok) throw new Error(`model_http_${res.status}`);
    const data = (await res.json()) as OpenAIResponse;
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      })),
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** OpenAI 兼容协议要求：assistant 消息回带 tool_calls，tool 消息回带 tool_call_id。 */
function toWireMessage(m: ModelMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
