import { Injectable, Logger } from '@nestjs/common';
import { charCount, clipChars } from './short-term-memory.service';

const EMBED_TIMEOUT_MS = 5_000;
export const EMBED_MAX_TEXTS = 64;
export const EMBED_MAX_TEXT_CHARS = 4_000;
export const EMBED_MAX_TOTAL_CHARS = 32_000;

export interface EmbeddingClientConfig {
  runtimeUrl?: string;
  runtimeToken?: string;
  fetchImpl?: typeof fetch;
}

/** 运行时 /embed 的薄客户端：任何异常都抛出，由调用方决定跳过检索或写入。 */
@Injectable()
export class EmbeddingClient {
  private readonly logger = new Logger(EmbeddingClient.name);
  private readonly runtimeUrl: string;
  private readonly runtimeToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: EmbeddingClientConfig = {}) {
    this.runtimeUrl = (
      cfg.runtimeUrl ??
      process.env.AGENT_RUNTIME_URL ??
      'http://localhost:4001'
    ).replace(/\/+$/, '');
    this.runtimeToken = cfg.runtimeToken ?? process.env.AGENT_RUNTIME_TOKEN;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > EMBED_MAX_TEXTS) throw new Error('embed_too_many_texts');
    if (texts.some((t) => t.trim() === '')) throw new Error('embed_empty_text');
    const input = texts.map((t) => clipChars(t.trim(), EMBED_MAX_TEXT_CHARS));
    if (input.reduce((sum, t) => sum + charCount(t), 0) > EMBED_MAX_TOTAL_CHARS) {
      throw new Error('embed_text_too_long');
    }

    const res = await this.fetchImpl(`${this.runtimeUrl}/embed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.runtimeToken ? { 'x-agent-runtime-token': this.runtimeToken } : {}),
      },
      body: JSON.stringify({ texts: input }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 回收失败响应体，避免连接/流资源残留。
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`embed_http_${res.status}`);
    }
    let data: { vectors?: unknown; dim?: unknown };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new Error('embed_bad_json');
    }
    const vectors = data.vectors;
    if (!Array.isArray(vectors) || vectors.length !== input.length) {
      throw new Error('embed_count_mismatch');
    }
    for (const v of vectors) {
      if (
        !Array.isArray(v) ||
        v.length === 0 ||
        !v.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error('embed_invalid_vector');
      }
    }
    return vectors as number[][];
  }
}
