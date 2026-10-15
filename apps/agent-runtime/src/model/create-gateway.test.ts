import { describe, it, expect } from 'vitest';
import { createGateway } from './create-gateway';
import { MockGateway } from './mock-gateway';
import { OpenAICompatGateway } from './openai-compat';

describe('createGateway', () => {
  it('无 DEEPSEEK_API_KEY 时回退 MockGateway', () => {
    expect(createGateway({})).toBeInstanceOf(MockGateway);
  });

  it('有 key 时使用 OpenAI 兼容 provider', () => {
    expect(createGateway({ DEEPSEEK_API_KEY: 'k' })).toBeInstanceOf(OpenAICompatGateway);
  });
});
