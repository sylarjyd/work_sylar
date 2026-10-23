import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, ModelGateway, ModelMessage } from './types';
import { ModelHttpError } from './errors';

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

/** provider 的函数名只允许 ^[a-zA-Z0-9_-]+$，点号会被 400 拒绝；逻辑名 web.search → wire 名 web_search。 */
const toWireName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/** 走 OpenAI 兼容的 /chat/completions（DeepSeek 即此协议）。 */
export class OpenAICompatGateway implements ModelGateway {
  constructor(private readonly cfg: OpenAICompatConfig) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // 反向表：wire 名（web_search）→ 逻辑名（web.search），把 provider 回传的名字还原。
    const wireToLogical = new Map(req.tools.map((t) => [toWireName(t.name), t.name]));
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
          ? req.tools.map((t) => ({ type: 'function', function: { ...t, name: toWireName(t.name) } }))
          : undefined,
      }),
    });
    if (!res.ok) throw new ModelHttpError(res.status, this.cfg.model);
    let data: OpenAIResponse;
    try {
      data = (await res.json()) as OpenAIResponse;
    } catch {
      throw new Error('model_bad_json');
    }
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id || randomUUID(),
        // 命中反向表则还原逻辑名；未命中（如幻觉出来的名字）原样透传。
        name: wireToLogical.get(tc.function.name) ?? tc.function.name,
        args: safeParse(tc.function.arguments),
      })),
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      model: this.cfg.model,
    };
  }
}

/** OpenAI 兼容协议要求：assistant 消息回带 tool_calls，tool 消息回带 tool_call_id。 */
function toWireMessage(m: ModelMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: toWireContent(m) };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id || randomUUID(),
      type: 'function',
      // 多轮里 assistant 的 tool_calls 会回带，同样要转成 wire 名，否则后续请求仍被拒。
      function: { name: toWireName(tc.name), arguments: JSON.stringify(tc.args) },
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  return out;
}

/**
 * 有媒体片段时 content 必须是 parts 数组；纯文本仍用字符串，兼容只支持字符串的老 provider。
 * 图片/音频按 Chat Completions 多模态格式；视频沿用同一风格（video_url），
 * 具体厂商若不支持会在其侧返回 400，由路由按模态预过滤避免走到这里。
 */
function toWireContent(m: ModelMessage): unknown {
  if (!m.parts?.length) return m.content;
  return m.parts.map((p) => {
    switch (p.type) {
      case 'image_url':
        return { type: 'image_url', image_url: { url: p.imageUrl } };
      case 'input_audio':
        return { type: 'input_audio', input_audio: { data: p.data, format: p.format } };
      case 'video_url':
        return { type: 'video_url', video_url: { url: p.videoUrl } };
      default:
        return { type: 'text', text: p.text };
    }
  });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
