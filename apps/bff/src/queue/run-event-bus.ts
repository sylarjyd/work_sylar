import type { Redis } from 'ioredis';
import { SSE_EVENT_NAMES, type SseEventName, type SseMessage } from '@ai-office/shared';

export interface RunEventBus {
  publish(runId: string, msg: SseMessage): Promise<void>;
  subscribe(runId: string, handler: (msg: SseMessage) => void): Promise<() => void>;
  /** 释放总线持有的连接；可选，供模块关闭时调用。 */
  close?(): Promise<void>;
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

  /** 单进程实现不持有外部资源。 */
  async close(): Promise<void> {}
}

const SUBSCRIBE_TIMEOUT_MS = 5000;
const UNSUBSCRIBE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;

/**
 * 多进程实现：事件经 Redis Pub/Sub 跨进程分发。
 * 进程内共享一条订阅连接（订阅态连接无法执行普通命令，但可订阅多个频道），
 * 频道按处理器数量引用计数，最后一个退订时才真正 unsubscribe。
 */
export class RedisRunEventBus implements RunEventBus {
  private sub: Redis | null = null;
  private readonly handlers = new Map<string, Set<(msg: SseMessage) => void>>();
  private readonly subscribed = new Set<string>();

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
      // 单连接订阅多频道；每次订阅新建连接会随 SSE 连接数线性膨胀。
      this.sub = this.subscriberFactory();
      this.sub.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
    }
    return this.sub;
  }

  /** 关闭共享订阅连接；quit 在断线时可能排队，超时后强制断开，避免拖住进程退出。 */
  async close(): Promise<void> {
    const sub = this.sub;
    this.sub = null;
    this.handlers.clear();
    this.subscribed.clear();
    if (!sub) return;
    try {
      await withTimeout(sub.quit(), CLOSE_TIMEOUT_MS);
    } catch {
      sub.disconnect();
    }
  }

  private dispatch(channel: string, raw: string): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    const msg = decodeEventFrame(raw);
    if (!msg) return;
    for (const handler of [...set]) {
      try {
        // handler 若为异步函数，其 rejection 也必须吞掉，否则会逃逸成未处理异常。
        Promise.resolve(handler(msg)).catch(() => undefined);
      } catch {
        // 同步异常隔离，不能打断同运行其他订阅者。
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
