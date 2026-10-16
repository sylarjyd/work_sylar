import { describe, it, expect } from 'vitest';
import { createEmbeddingGateway } from './create-embedding-gateway';
import { MockEmbeddingGateway } from './mock-embedding';
import { OpenAICompatEmbeddingGateway } from './openai-compat-embedding';

describe('createEmbeddingGateway', () => {
  it('无 EMBEDDING_API_KEY 时回退 mock', () => {
    expect(createEmbeddingGateway({})).toBeInstanceOf(MockEmbeddingGateway);
  });

  it('有 EMBEDDING_API_KEY 时用 OpenAI 兼容实现', () => {
    const gw = createEmbeddingGateway({ EMBEDDING_API_KEY: 'k' });
    expect(gw).toBeInstanceOf(OpenAICompatEmbeddingGateway);
    expect(gw.dim).toBe(1024);
  });

  it('EMBEDDING_DIM 覆盖默认维度', () => {
    expect(createEmbeddingGateway({ EMBEDDING_DIM: '512' }).dim).toBe(512);
  });
});
