import type { ModelGateway } from './types';
import { OpenAICompatGateway } from './openai-compat';
import { MockGateway } from './mock-gateway';
import { RoutingGateway } from './routing-gateway';

interface ProviderConfig {
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
}

/** 解析 MODEL_PROVIDERS；格式非法时启动即失败，避免带病运行。 */
export function parseProviders(raw: string | undefined): ProviderConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid_MODEL_PROVIDERS');
  }
  if (!Array.isArray(parsed)) throw new Error('invalid_MODEL_PROVIDERS');
  return parsed.map((item) => {
    if (item === null || typeof item !== 'object') throw new Error('invalid_MODEL_PROVIDERS');
    const p = item as Record<string, unknown>;
    if (
      typeof p.model !== 'string' ||
      typeof p.baseUrl !== 'string' ||
      typeof p.apiKeyEnv !== 'string'
    ) {
      throw new Error('invalid_MODEL_PROVIDERS');
    }
    return { model: p.model, baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv };
  });
}

/**
 * 配置了 MODEL_PROVIDERS 且至少一个 provider 有 key → 多模型路由；
 * 否则沿用单模型配置；完全没有 key → MockGateway（本地/CI）。
 */
export function createGateway(env: NodeJS.ProcessEnv = process.env): ModelGateway {
  const providers = parseProviders(env.MODEL_PROVIDERS).filter((p) => env[p.apiKeyEnv]);
  if (providers.length > 0) {
    return new RoutingGateway(
      providers.map((p) => ({
        model: p.model,
        gateway: new OpenAICompatGateway({
          baseUrl: p.baseUrl,
          apiKey: env[p.apiKeyEnv] as string,
          model: p.model,
        }),
      })),
    );
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return new MockGateway();
  return new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.MODEL_NAME ?? 'deepseek-chat',
  });
}
