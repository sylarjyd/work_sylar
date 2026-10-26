import { Redis } from 'ioredis';

/** 运行总线 Redis 客户端的注入令牌；Task 8 的 QueueModule 按 REDIS_URL 决定是否提供。 */
export const RUN_REDIS = Symbol('RUN_REDIS');

/** 普通命令连接：用于发布运行事件与控制指令；未配置 Redis 时不创建。 */
export function createRunRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

/**
 * 订阅连接工厂：Redis 进入订阅态后不能再执行普通命令，且每条订阅需要自己的连接，
 * 因此每次调用都新建实例，不能复用普通命令连接。
 */
export function createSubscriber(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}
