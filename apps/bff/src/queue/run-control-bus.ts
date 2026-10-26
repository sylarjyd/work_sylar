import type { Redis } from 'ioredis';

/** 浏览器/API 侧发往执行器的控制指令：确认（同意或拒绝）与取消。 */
export type RunControlMessage =
  | { type: 'confirm'; confirmId: string; approved: boolean }
  | { type: 'cancel' };

export interface RunControlBus {
  publish(runId: string, msg: RunControlMessage): Promise<void>;
  subscribe(runId: string, handler: (msg: RunControlMessage) => void): Promise<() => void>;
}

/** 单个运行的控制频道；与事件频道分开，避免控制指令混入 SSE 流。 */
export const runControlChannel = (runId: string): string => `run:${runId}:control`;

/** 单进程实现：仅在当前进程内投递，不使用全局 EventEmitter 以免订阅跨实例泄露。 */
export class LocalRunControlBus implements RunControlBus {
  private readonly handlers = new Map<string, Set<(msg: RunControlMessage) => void>>();

  async publish(runId: string, msg: RunControlMessage): Promise<void> {
    const subscribers = this.handlers.get(runId);
    if (!subscribers) return;
    for (const handler of [...subscribers]) {
      try {
        handler(msg);
      } catch {
        // 单个订阅者异常隔离，保证执行器仍能收到控制指令。
      }
    }
  }

  async subscribe(runId: string, handler: (msg: RunControlMessage) => void): Promise<() => void> {
    let subscribers = this.handlers.get(runId);
    if (!subscribers) {
      subscribers = new Set();
      this.handlers.set(runId, subscribers);
    }
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
      if (subscribers.size === 0 && this.handlers.get(runId) === subscribers) {
        this.handlers.delete(runId);
      }
    };
  }
}

/** 多进程实现：控制指令经 Redis Pub/Sub 送达持有该运行执行器的 worker。 */
export class RedisRunControlBus implements RunControlBus {
  constructor(
    private readonly publisher: Redis,
    private readonly subscriberFactory: () => Redis,
  ) {}

  async publish(runId: string, msg: RunControlMessage): Promise<void> {
    await this.publisher.publish(runControlChannel(runId), JSON.stringify(msg));
  }

  async subscribe(runId: string, handler: (msg: RunControlMessage) => void): Promise<() => void> {
    const channel = runControlChannel(runId);
    const subscriber = this.subscriberFactory();
    subscriber.on('message', (_channel: string, raw: string) => {
      const msg = decodeControlFrame(raw);
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
      if (closed) return;
      closed = true;
      await subscriber.unsubscribe(channel).catch(() => undefined);
      subscriber.disconnect();
    };
  }
}

/** 校验并解码控制帧；未知 type、confirm 字段不合法或坏 JSON 一律丢弃。 */
function decodeControlFrame(raw: string): RunControlMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { type, confirmId, approved } = parsed as {
      type?: unknown;
      confirmId?: unknown;
      approved?: unknown;
    };
    if (type === 'cancel') return { type: 'cancel' };
    if (type === 'confirm' && typeof confirmId === 'string' && typeof approved === 'boolean') {
      return { type: 'confirm', confirmId, approved };
    }
    return null;
  } catch {
    return null;
  }
}
