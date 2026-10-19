import type { ModelGateway } from './types';
import { OpenAICompatGateway } from './openai-compat';
import { MockGateway } from './mock-gateway';

/** 有 DEEPSEEK_API_KEY 就走 OpenAI 兼容真实模型；否则回退 MockGateway，保证本地/CI 免外部依赖。 */
export function createGateway(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return new MockGateway();
  return new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.MODEL_NAME ?? 'deepseek-chat',
  });
}
