import type { ModelGateway } from './types';
import { OpenAICompatGateway } from './openai-compat';
import { MockGateway } from './mock-gateway';

export function createGateway(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return new MockGateway();
  return new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.MODEL_NAME ?? 'deepseek-chat',
  });
}
