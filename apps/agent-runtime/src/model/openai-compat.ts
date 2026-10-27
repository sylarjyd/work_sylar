import { randomUUID } from 'node:crypto';
import type { ChatOptions, ChatRequest, ChatResponse, ModelGateway, ModelMessage } from './types';
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

/** 流式分片：正文与 tool_calls 都按增量下发，usage 只在末尾（include_usage）出现。 */
interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
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

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    // 反向表：wire 名（web_search）→ 逻辑名（web.search），把 provider 回传的名字还原。
    const wireToLogical = new Map(req.tools.map((t) => [toWireName(t.name), t.name]));
    if (opts?.onDelta) return this.stream(req, wireToLogical, opts.onDelta);

    const res = await this.post(req, false);
    if (!res.ok) throw new ModelHttpError(res.status, this.cfg.model);
    let data: OpenAIResponse;
    try {
      data = (await res.json()) as OpenAIResponse;
    } catch {
      throw new Error('model_bad_json');
    }
    return toChatResponse(data, this.cfg.model, wireToLogical);
  }

  private post(req: ChatRequest, stream: boolean): Promise<Response> {
    return fetch(`${this.cfg.baseUrl}/chat/completions`, {
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
        // include_usage：OpenAI/DeepSeek 在末尾补一帧 usage，否则流式拿不到 token 数。
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
    });
  }

  private async stream(
    req: ChatRequest,
    wireToLogical: Map<string, string>,
    onDelta: (text: string, model: string) => void,
  ): Promise<ChatResponse> {
    const res = await this.post(req, true);
    if (!res.ok) throw new ModelHttpError(res.status, this.cfg.model);
    // 少数 provider 会忽略 stream 直接回 JSON：按一次性补全消费，不能白跑一趟。
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      let data: OpenAIResponse;
      try {
        data = (await res.json()) as OpenAIResponse;
      } catch {
        throw new Error('model_bad_json');
      }
      const out = toChatResponse(data, this.cfg.model, wireToLogical);
      if (out.content) onDelta(out.content, this.cfg.model);
      return out;
    }
    if (!res.body) throw new Error('model_stream_no_body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // tool_calls 按 index 分片下发，必须累积后在上游结束后一次性解析，不能逐片 JSON.parse。
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
    let content = '';
    let usage = { input: 0, output: 0 };
    let buffer = '';

    const handlePayload = (payload: string): void => {
      if (!payload || payload === '[DONE]') return;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIStreamChunk;
      } catch {
        return;
      }
      if (chunk.error) throw new Error('model_stream_error');
      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        content += delta.content;
        onDelta(delta.content, this.cfg.model);
      }
      for (const tc of delta.tool_calls ?? []) {
        const prev = toolAcc.get(tc.index) ?? { id: '', name: '', arguments: '' };
        toolAcc.set(tc.index, {
          id: tc.id || prev.id,
          name: prev.name + (tc.function?.name ?? ''),
          arguments: prev.arguments + (tc.function?.arguments ?? ''),
        });
      }
    };

    const handleFrame = (frame: string): void => {
      for (const line of frame.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) handlePayload(trimmed.slice(5).trim());
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // 部分代理回 CRLF；先归一化行尾，切帧逻辑才只需要处理 \n\n。
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        for (;;) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleFrame(frame);
        }
      }
      // 流末尾可能缺空行，残留帧也要消费，否则最后一段正文会丢。
      if (buffer.trim()) handleFrame(buffer);
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    }

    return {
      content,
      toolCalls: [...toolAcc.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id || randomUUID(),
          // 命中反向表则还原逻辑名；未命中（如幻觉出来的名字）原样透传。
          name: wireToLogical.get(tc.name) ?? tc.name,
          args: safeParse(tc.arguments),
        })),
      usage,
      model: this.cfg.model,
    };
  }
}

function toChatResponse(
  data: OpenAIResponse,
  model: string,
  wireToLogical: Map<string, string>,
): ChatResponse {
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
    model,
  };
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
