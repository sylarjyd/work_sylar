import type { AdminLegacyProviderDto } from '@ai-office/shared';

export interface EnvModelProvider {
  /** 展示用分组名：优先 apiKeyEnv；单模型配置为 default。不含密钥。 */
  name: string;
  model: string;
  baseUrl: string;
  /** 未配置对应环境变量时为空串；调用方据此判断能否真正发请求。 */
  apiKey: string;
}

export const DEFAULT_ENV_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_ENV_MODEL = 'deepseek-chat';

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/**
 * 与 runtime 的 MODEL_PROVIDERS 语义保持一致：
 * MODEL_PROVIDERS → DEEPSEEK_API_KEY + MODEL_NAME → 空（runtime 走 Mock）。
 * BFF 侧对非法配置保持宽容：管理端仍需可用，真正调用由 runtime 失败关闭。
 */
export function parseEnvModelProviders(env: NodeJS.ProcessEnv): EnvModelProvider[] {
  const raw = env.MODEL_PROVIDERS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: EnvModelProvider[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;
      if (typeof p.model !== 'string' || p.model === '') continue;
      if (typeof p.baseUrl !== 'string' || p.baseUrl === '') continue;
      if (typeof p.apiKeyEnv !== 'string' || p.apiKeyEnv === '') continue;
      if (seen.has(p.model)) continue;
      seen.add(p.model);
      out.push({
        name: p.apiKeyEnv,
        model: p.model,
        baseUrl: normalizeBaseUrl(p.baseUrl),
        apiKey: env[p.apiKeyEnv] ?? '',
      });
    }
    return out;
  }
  if (!env.DEEPSEEK_API_KEY) return [];
  return [
    {
      name: 'default',
      model: env.MODEL_NAME || DEFAULT_ENV_MODEL,
      baseUrl: normalizeBaseUrl(env.MODEL_BASE_URL || DEFAULT_ENV_BASE_URL),
      apiKey: env.DEEPSEEK_API_KEY,
    },
  ];
}

/** 管理端兜底展示：只保留分组名与模型名，绝不暴露 baseUrl 或密钥。 */
export function listEnvProviderGroups(env: NodeJS.ProcessEnv): AdminLegacyProviderDto[] {
  const entries = parseEnvModelProviders(env);
  if (entries.length === 0) {
    return [{ name: 'default', models: [env.MODEL_NAME || DEFAULT_ENV_MODEL] }];
  }
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    groups.set(e.name, [...(groups.get(e.name) ?? []), e.model]);
  }
  return [...groups].map(([name, models]) => ({ name, models }));
}
