import type { Redis } from 'ioredis';
import { SSE_EVENT_NAMES, type SseEventName, type SseMessage } from '@ai-office/shared';

export interface RunEventBus {
  publish(runId: string, msg: SseMessage): Promise<void>;
  subscribe(runId: string, handler: (msg: SseMessage) => void): Promise<() => void>;
}

/** 单个运行的运行事件频道；跨进程分发时 publisher 与 subscriber 共用。 */
export const runEventChannel = (runId: string): string => `run:${runId}:events`;

/** 单进程实现：无 Redis 时使用，订阅表只存活于当前进程。 */
export class LocalRunEventBus implements RunEventBus {
  private readonly handlers = new Map<string, Set<(msg: SseMessage) => void>>();

  async publish(runId: string, msg: SseMessage): Promise<void> {
    const subscribers = this.handlers.get(runId);
    if (!subscribers) return;
    // 复制一份再遍历，避免订阅者在回调里退订导致迭代器失效。
    for (const handler of [...subscribers]) {
      try {
        handler(msg);
      } catch {
        // 单个订阅者异常不能影响同运行的其他人。
      }
    }
  }

  async subscribe(runId: string, handler: (msg: SseMessage) => void): Promise<() => void> {
    let subscribers = this.handlers.get(runId);
    if (!subscribers) {
      subscribers = new Set();
      this.handlers.set(runId, subscribers);
    }
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
      // 最后一个订阅者退订后清空该运行，避免长期运行时 Map 无限增长。
      if (subscribers.size === 0 && this.handlers.get(runId) === subscribers) {
        this.handlers.delete(runId);
      }
    };
  }
}

/**
 * 多进程实现：事件经 Redis Pub/Sub 跨进程分发。
 * 订阅方必须使用独立连接（Factory 每次新建），Redis 订阅态连接无法再执行普通命令。
 */
export class RedisRunEventBus implements RunEventBus {
  constructor(
    private readonly publisher: Redis,
    private readonly subscriberFactory: () => Redis,
  ) {}

  async publish(runId: string, msg: SseMessage): Promise<void> {
    await this.publisher.publish(
      runEventChannel(runId),
      JSON.stringify({ event: msg.event, data: msg.data }),
    );
  }

  async subscribe(runId: string, handler: (msg: SseMessage) => void): Promise<() => void> {
    const channel = runEventChannel(runId);
    const subscriber = this.subscriberFactory();
    // 先挂监听再订阅，避免订阅确认后、监听注册前到达的帧被丢弃。
    subscriber.on('message', (_channel: string, raw: string) => {
      const msg = decodeEventFrame(raw);
      if (!msg) return;
      try {
        handler(msg);
      } catch {
        // 订阅者自身异常不能打断 Redis 连接的事件分发。
      }
    });
    await subscriber.subscribe(channel);

    let closed = false;
    return async () => {
      // 幂等：重复退订不再触碰连接。
      if (closed) return;
      closed = true;
      await subscriber.unsubscribe(channel).catch(() => undefined);
      subscriber.disconnect();
    };
  }
}

/** 校验并解码事件帧；坏 JSON、缺字段、非法事件名一律返回 null。 */
function decodeEventFrame(raw: string): SseMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { event, data } = parsed as { event?: unknown; data?: unknown };
    if (typeof event !== 'string') return null;
    if (!(SSE_EVENT_NAMES as readonly string[]).includes(event)) return null;
    if (!('data' in (parsed as object))) return null;
    return { event: event as SseEventName, data };
  } catch {
    return null;
  }
}
