/** 队列运行时配置：进程启动时解析一次，运行期不随环境变量变化。 */
export interface QueueRuntimeConfig {
  /** 是否启用 Redis 队列；false 时所有运行走进程内联执行。 */
  enabled: boolean;
  /** BullMQ 队列名。 */
  name: string;
  /** 单进程 worker 并发数。 */
  concurrency: number;
  /** Redis 连接串；未配置时为 null。 */
  redisUrl: string | null;
}

/**
 * 解析整数：缺失、空白或非整数回落到 fallback，合法值夹取到 [min, max]。
 * 配置错误不应阻止进程启动，夹取比抛错更适合队列这类旁路能力。
 */
export function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * 读取队列配置。
 * 无 REDIS_URL 时队列关闭，submit 走内联执行（本地开发与测试的默认形态）；
 * RUN_QUEUE_ENABLED=0 可在保留 Redis 配置的前提下强制内联，便于故障时降级。
 */
export function readQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueRuntimeConfig {
  const redisUrl = env.REDIS_URL?.trim() || null;
  const enabled = redisUrl !== null && env.RUN_QUEUE_ENABLED !== '0';
  return {
    enabled,
    name: env.RUN_QUEUE_NAME?.trim() || 'runs',
    concurrency: clampInt(env.RUN_QUEUE_CONCURRENCY, 1, 32, 4),
    redisUrl,
  };
}
