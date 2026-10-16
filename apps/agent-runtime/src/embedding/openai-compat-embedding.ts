import type { EmbeddingGateway } from './types';

interface EmbeddingsResponse {
  data?: { index?: number; embedding: number[] }[];
}

export interface OpenAICompatEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
}

/** 走 OpenAI 兼容的 /embeddings（SiliconFlow / OpenAI / 兼容网关）。 */
export class OpenAICompatEmbeddingGateway implements EmbeddingGateway {
  readonly dim: number;
  constructor(private readonly cfg: OpenAICompatEmbeddingConfig) {
    this.dim = cfg.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedding_http_${res.status}`);
    let data: EmbeddingsResponse;
    try {
      data = (await res.json()) as EmbeddingsResponse;
    } catch {
      throw new Error('embedding_bad_json');
    }
    const rows = [...(data.data ?? [])];
    // provider 不保证顺序：按 index 升序还原，缺 index 时按原序。
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.map((r) => r.embedding);
  }
}
