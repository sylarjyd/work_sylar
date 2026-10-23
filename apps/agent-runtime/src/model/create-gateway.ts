import type { RunModelRoute } from '@ai-office/shared';
import type { ModelGateway } from './types';
import type { ModelObserver } from './observed-gateway';
import { ObservedGateway } from './observed-gateway';
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
  const providers = parsed.map((item) => {
    if (item === null || typeof item !== 'object') throw new Error('invalid_MODEL_PROVIDERS');
    const p = item as Record<string, unknown>;
    if (
      typeof p.model !== 'string' ||
      typeof p.baseUrl !== 'string' ||
      typeof p.apiKeyEnv !== 'string' ||
      p.model.length === 0 ||
      p.baseUrl.length === 0 ||
      p.apiKeyEnv.length === 0
    ) {
      throw new Error('invalid_MODEL_PROVIDERS');
    }
    return { model: p.model, baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv };
  });
  if (new Set(providers.map((p) => p.model)).size !== providers.length) {
    throw new Error('invalid_MODEL_PROVIDERS');
  }
  return providers;
}

/**
 * 配置了 MODEL_PROVIDERS 且至少一个 provider 有 key → 多模型路由；
 * 否则沿用单模型配置；完全没有 key → MockGateway（本地/CI）。
 * 传 observer 时单模型网关外包一层观测；不传则保持原实例，兼容既有调用方。
 */
export function createGateway(
  env: NodeJS.ProcessEnv = process.env,
  observer?: ModelObserver,
): ModelGateway {
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
      observer,
    );
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const mock = new MockGateway();
    return observer ? new ObservedGateway(mock, 'mock', observer) : mock;
  }
  const model = env.MODEL_NAME ?? 'deepseek-chat';
  const inner = new OpenAICompatGateway({
    baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model,
  });
  return observer ? new ObservedGateway(inner, model, observer) : inner;
}

/**
 * 按 BFF 本次下发的路由构建临时网关；返回 undefined 表示沿用启动网关（Mock/环境变量）。
 * 路由来自内部请求体，属于受信输入，但仍做结构校验，避免配置错误导致静默调用错厂商。
 */
export function createGatewayFromRoutes(
  routes: RunModelRoute[] | undefined,
  observer?: ModelObserver,
): ModelGateway | undefined {
  if (!routes || routes.length === 0) return undefined;
  const seen = new Set<string>();
  const built = routes.map((route) => {
    if (
      !route ||
      typeof route.model !== 'string' ||
      route.model === '' ||
      typeof route.baseUrl !== 'string' ||
      route.baseUrl === '' ||
      typeof route.apiKey !== 'string' ||
      route.apiKey === ''
    ) {
      throw new Error('invalid_model_routes');
    }
    if (seen.has(route.model)) throw new Error('invalid_model_routes');
    seen.add(route.model);
    return {
      model: route.model,
      gateway: new OpenAICompatGateway({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        model: route.model,
      }),
    };
  });
  return new RoutingGateway(built, observer);
}
