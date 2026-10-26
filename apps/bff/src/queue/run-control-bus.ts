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

const SUBSCRIBE_TIMEOUT_MS = 5000;
const UNSUBSCRIBE_TIMEOUT_MS = 5000;

/**
 * 多进程实现：控制指令经 Redis Pub/Sub 送达持有该运行执行器的 worker。
 * 与事件总线一致：进程内共享订阅连接，频道按处理器数量引用计数退订。
 */
export class RedisRunControlBus implements RunControlBus {
  private sub: Redis | null = null;
  private readonly handlers = new Map<string, Set<(msg: RunControlMessage) => void>>();
  private readonly subscribed = new Set<string>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriberFactory: () => Redis,
  ) {}

  async publish(runId: string, msg: RunControlMessage): Promise<void> {
    await this.publisher.publish(runControlChannel(runId), JSON.stringify(msg));
  }

  async subscribe(
    runId: string,
    handler: (msg: RunControlMessage) => void,
  ): Promise<() => void> {
    const channel = runControlChannel(runId);
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    if (!this.subscribed.has(channel)) {
      try {
        await withTimeout(this.ensureSubscriber().subscribe(channel), SUBSCRIBE_TIMEOUT_MS);
        this.subscribed.add(channel);
      } catch (err) {
        // 订阅失败不留下悬挂处理器；连接交给 ioredis 自动重连。
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(channel);
        throw err;
      }
    }

    let closed = false;
    return async () => {
      // 幂等：重复退订不再触碰连接。
      if (closed) return;
      closed = true;
      const current = this.handlers.get(channel);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.handlers.delete(channel);
        this.subscribed.delete(channel);
        const sub = this.sub;
        // 断线时 unsubscribe 可能排队不返回；超时后放弃等待，连接由 ioredis 重连。
        if (sub) {
          await withTimeout(sub.unsubscribe(channel), UNSUBSCRIBE_TIMEOUT_MS).catch(
            () => undefined,
          );
        }
      }
    };
  }

  private ensureSubscriber(): Redis {
    if (!this.sub) {
      // 单连接订阅多频道；每次订阅新建连接会随并发订阅数线性膨胀。
      this.sub = this.subscriberFactory();
      this.sub.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
    }
    return this.sub;
  }

  private dispatch(channel: string, raw: string): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    const msg = decodeControlFrame(raw);
    if (!msg) return;
    for (const handler of [...set]) {
      try {
        // 控制处理器失败不应拖垮分发；异步 rejection 同样吞掉。
        Promise.resolve(handler(msg)).catch(() => undefined);
      } catch {
        // 同步异常隔离，保证执行器仍能收到控制指令。
      }
    }
  }
}

/** 给 Redis 操作加超时；断线时命令可能无限排队，清理流程不能因此卡死。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis 总线操作超时（${ms}ms）`)), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
