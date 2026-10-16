import type { EmbeddingGateway } from './types';
import { MockEmbeddingGateway } from './mock-embedding';
import { OpenAICompatEmbeddingGateway } from './openai-compat-embedding';

/** 有 EMBEDDING_API_KEY → OpenAI 兼容实现；否则 mock（与 createGateway 同构）。 */
export function createEmbeddingGateway(env: NodeJS.ProcessEnv = process.env): EmbeddingGateway {
  const dim = Number(env.EMBEDDING_DIM ?? 1024);
  const apiKey = env.EMBEDDING_API_KEY;
  if (!apiKey) return new MockEmbeddingGateway(dim);
  return new OpenAICompatEmbeddingGateway({
    baseUrl: env.EMBEDDING_BASE_URL ?? 'https://api.siliconflow.cn/v1',
    apiKey,
    model: env.EMBEDDING_MODEL ?? 'BAAI/bge-large-zh-v1.5',
    dim,
  });
}
