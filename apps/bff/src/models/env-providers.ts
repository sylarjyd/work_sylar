import { Logger } from '@nestjs/common';
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

const logger = new Logger('EnvModelProviders');

/** 只读自有属性且必须是字符串，避免 __proto__ 等原型键被当成密钥。 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!Object.hasOwn(env, name)) return undefined;
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/** 解析 MODEL_PROVIDERS；宽容跳过非法项，告警文本不得包含配置值或密钥。 */
function parseModelProviders(raw: string, env: NodeJS.ProcessEnv): EnvModelProvider[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('MODEL_PROVIDERS 不是合法 JSON，已忽略该配置');
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn('MODEL_PROVIDERS 不是数组，已忽略该配置');
    return [];
  }
  const seen = new Set<string>();
  const out: EnvModelProvider[] = [];
  for (const [index, item] of parsed.entries()) {
    if (item === null || typeof item !== 'object') {
      logger.warn(`MODEL_PROVIDERS 第 ${index} 项不是对象，已忽略`);
      continue;
    }
    const p = item as Record<string, unknown>;
    if (
      typeof p.model !== 'string' ||
      p.model === '' ||
      typeof p.baseUrl !== 'string' ||
      typeof p.apiKeyEnv !== 'string' ||
      p.apiKeyEnv === ''
    ) {
      logger.warn(`MODEL_PROVIDERS 第 ${index} 项字段不完整，已忽略`);
      continue;
    }
    const baseUrl = normalizeBaseUrl(p.baseUrl);
    if (baseUrl === '') {
      logger.warn(`MODEL_PROVIDERS 第 ${index} 项 Base URL 归一化后为空，已忽略`);
      continue;
    }
    if (seen.has(p.model)) {
      logger.warn(`MODEL_PROVIDERS 第 ${index} 项模型重复，已忽略`);
      continue;
    }
    seen.add(p.model);
    out.push({ name: p.apiKeyEnv, model: p.model, baseUrl, apiKey: readEnv(env, p.apiKeyEnv) ?? '' });
  }
  return out;
}

/** DEEPSEEK_API_KEY 单模型兜底；未配置密钥或 Base URL 无效时返回 null。 */
function deepseekProvider(env: NodeJS.ProcessEnv): EnvModelProvider | null {
  const apiKey = readEnv(env, 'DEEPSEEK_API_KEY');
  if (!apiKey) return null;
  const baseUrl = normalizeBaseUrl(readEnv(env, 'MODEL_BASE_URL') || DEFAULT_ENV_BASE_URL);
  if (baseUrl === '') {
    // 不能把无主机的地址静默换成默认厂商：既不安全，也会与 runtime 的实际行为不一致。
    logger.warn('MODEL_BASE_URL 归一化后为空，已忽略 DEEPSEEK_API_KEY 兜底');
    return null;
  }
  return {
    name: 'default',
    model: readEnv(env, 'MODEL_NAME') || DEFAULT_ENV_MODEL,
    baseUrl,
    apiKey,
  };
}

/**
 * 解析环境变量，保留暂时缺密钥的条目，仅供管理端展示。
 * 运行与客户端模型选择必须使用 resolveEnvModelProviders。
 * 有意收紧：空字符串的 MODEL_NAME / MODEL_BASE_URL 按未设置处理，避免把空模型名
 * 或空 Base URL 当成可用配置；runtime 用 ?? 会保留空串。
 */
export function parseEnvModelProviders(env: NodeJS.ProcessEnv): EnvModelProvider[] {
  const raw = readEnv(env, 'MODEL_PROVIDERS');
  if (raw) return parseModelProviders(raw, env);
  const fallback = deepseekProvider(env);
  return fallback ? [fallback] : [];
}

/**
 * 客户端模型目录与运行路由使用的最终解析，复刻 runtime 的回退顺序：
 * 有密钥的 MODEL_PROVIDERS → DEEPSEEK_API_KEY → 空数组（runtime 走 Mock）。
 * MODEL_PROVIDERS 全部缺密钥时必须继续回退，否则展示（Mock）与实际运行不一致。
 */
export function resolveEnvModelProviders(env: NodeJS.ProcessEnv): EnvModelProvider[] {
  const raw = readEnv(env, 'MODEL_PROVIDERS');
  if (raw) {
    const configured = parseModelProviders(raw, env).filter((p) => p.apiKey !== '');
    if (configured.length > 0) return configured;
  }
  const fallback = deepseekProvider(env);
  return fallback ? [fallback] : [];
}

/** 管理端兜底展示：只保留分组名与模型名，绝不暴露 baseUrl 或密钥。 */
export function listEnvProviderGroups(env: NodeJS.ProcessEnv): AdminLegacyProviderDto[] {
  const entries = parseEnvModelProviders(env);
  if (entries.length === 0) {
    return [{ name: 'default', models: [readEnv(env, 'MODEL_NAME') || DEFAULT_ENV_MODEL] }];
  }
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    groups.set(e.name, [...(groups.get(e.name) ?? []), e.model]);
  }
  return [...groups].map(([name, models]) => ({ name, models }));
}
