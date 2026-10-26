import { collectDefaultMetrics, Registry } from 'prom-client';

export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];
export const MODEL_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60];
export const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** 队列等待以秒计：短等待看清排队抖动，长桶覆盖数分钟以上的拥塞。 */
export const RUN_QUEUE_WAIT_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600];

export interface RegistryOptions {
  defaultMetrics?: boolean;
}

/** 每个应用独立 Registry；测试传 defaultMetrics:false，避免默认指标污染断言。 */
export function createMetricsRegistry(options: RegistryOptions = {}): Registry {
  const registry = new Registry();
  if (options.defaultMetrics !== false) {
    collectDefaultMetrics({ register: registry, prefix: 'ai_office_' });
  }
  return registry;
}

/** 标签值截断到 max，尾部附稳定哈希，保证截断后仍可区分。 */
export function boundedLabel(value: string, max = 64): string {
  const limit = Math.max(9, max);
  if (value.length <= limit) return value;
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  const suffix = `#${hash.toString(16).padStart(8, '0')}`;
  return value.slice(0, limit - suffix.length) + suffix;
}
