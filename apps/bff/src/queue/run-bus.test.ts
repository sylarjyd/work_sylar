import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SseMessage } from '@ai-office/shared';
import { LocalRunEventBus, RedisRunEventBus } from './run-event-bus';
import { LocalRunControlBus, RedisRunControlBus, type RunControlMessage } from './run-control-bus';

/** 假的订阅连接：记录 subscribe/unsubscribe/disconnect，并允许手工投递 message 帧。 */
function createFakeSubscriber() {
  let messageListener: ((channel: string, raw: string) => void) | undefined;
  const redis = {
    subscribe: vi.fn(async (_channel: string) => 1),
    unsubscribe: vi.fn(async (_channel: string) => 0),
    disconnect: vi.fn(),
    on: vi.fn((event: string, listener: (channel: string, raw: string) => void) => {
      if (event === 'message') messageListener = listener;
      return redis;
    }),
  };
  return {
    redis: redis as unknown as Redis,
    mocks: redis,
    emit(channel: string, raw: string) {
      messageListener?.(channel, raw);
    },
    listenerReady: () => messageListener !== undefined,
  };
}

function fakePublisher() {
  return { publish: vi.fn(async () => 1) };
}

const eventFrame = (event: string, data: unknown): string => JSON.stringify({ event, data });

describe('LocalRunEventBus', () => {
  it('发布后可订阅，退订后不再收到', async () => {
    const bus = new LocalRunEventBus();
    const got: SseMessage[] = [];
    const off = await bus.subscribe('r1', (m) => got.push(m));
    await bus.publish('r1', { event: 'status', data: { status: 'running' } });
    await bus.publish('r1', { event: 'done', data: { runId: 'r1' } });
    off();
    await bus.publish('r1', { event: 'status', data: { status: 'done' } });
    expect(got.map((m) => m.event)).toEqual(['status', 'done']);
  });

  it('不同运行互不串扰', async () => {
    const bus = new LocalRunEventBus();
    const got: SseMessage[] = [];
    await bus.subscribe('r1', (m) => got.push(m));
    await bus.publish('r2', { event: 'status', data: {} });
    expect(got).toHaveLength(0);
  });

  it('单个订阅者抛错不影响其他订阅者', async () => {
    const bus = new LocalRunEventBus();
    const got: SseMessage[] = [];
    // 先注册抛错者，验证后续订阅者仍能收到。
    await bus.subscribe('r1', () => {
      throw new Error('subscriber boom');
    });
    await bus.subscribe('r1', (m) => got.push(m));
    await expect(bus.publish('r1', { event: 'done', data: {} })).resolves.toBeUndefined();
    expect(got).toHaveLength(1);
  });
});

describe('LocalRunControlBus', () => {
  it('confirm/cancel 可送达，退订后不再收到', async () => {
    const bus = new LocalRunControlBus();
    const got: RunControlMessage[] = [];
    const off = await bus.subscribe('r1', (m) => got.push(m));
    await bus.publish('r1', { type: 'confirm', confirmId: 'c1', approved: true });
    await bus.publish('r1', { type: 'cancel' });
    off();
    await bus.publish('r1', { type: 'cancel' });
    expect(got).toEqual([
      { type: 'confirm', confirmId: 'c1', approved: true },
      { type: 'cancel' },
    ]);
  });

  it('控制消息与事件通道互不串扰', async () => {
    const bus = new LocalRunControlBus();
    const got: RunControlMessage[] = [];
    await bus.subscribe('r1', (m) => got.push(m));
    await bus.publish('r2', { type: 'cancel' });
    expect(got).toHaveLength(0);
  });
});

describe('RedisRunEventBus', () => {
  it('publish 向 run:<id>:events 发送 JSON 帧', async () => {
    const publisher = fakePublisher();
    const bus = new RedisRunEventBus(
      publisher as unknown as Redis,
      () => {
        throw new Error('publish 不应创建订阅连接');
      },
    );
    const msg: SseMessage = { event: 'status', data: { status: 'running' } };
    await bus.publish('r1', msg);
    expect(publisher.publish).toHaveBeenCalledWith(
      'run:r1:events',
      JSON.stringify({ event: 'status', data: { status: 'running' } }),
    );
  });

  it('同一运行的多次订阅共享连接，按频道引用计数退订', async () => {
    const sub = createFakeSubscriber();
    const factory = vi.fn(() => sub.redis);
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, factory);
    const first: SseMessage[] = [];
    const second: SseMessage[] = [];

    const offFirst = await bus.subscribe('r1', (m) => first.push(m));
    const offSecond = await bus.subscribe('r1', (m) => second.push(m));

    // 单连接订阅多频道：两个订阅者只建一条连接、只 subscribe 一次。
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sub.mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(sub.mocks.subscribe).toHaveBeenCalledWith('run:r1:events');
    expect(sub.listenerReady()).toBe(true);

    sub.emit('run:r1:events', eventFrame('step', { seq: 1 }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    // 退订其一仍能收到；频道尚未解绑。
    await offFirst();
    expect(sub.mocks.unsubscribe).not.toHaveBeenCalled();
    sub.emit('run:r1:events', eventFrame('step', { seq: 2 }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);

    // 全部退订后只解绑一次。
    await offSecond();
    expect(sub.mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.mocks.unsubscribe).toHaveBeenCalledWith('run:r1:events');
  });

  it('重复退订幂等，只执行一次 unsubscribe', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const off = await bus.subscribe('r1', () => undefined);

    await off();
    await off();
    await off();

    expect(sub.mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribe 失败时抛出，且可重试、无处理器残留', async () => {
    const sub = createFakeSubscriber();
    sub.mocks.subscribe.mockRejectedValueOnce(new Error('subscribe failed'));
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const got: SseMessage[] = [];

    await expect(bus.subscribe('r1', (m) => got.push(m))).rejects.toThrow('subscribe failed');

    // 失败订阅的处理器已清理，连接上到达的帧不会回调它。
    sub.emit('run:r1:events', eventFrame('step', { seq: 1 }));
    expect(got).toHaveLength(0);

    // 共享连接可被后续订阅复用并重试成功。
    const off = await bus.subscribe('r1', (m) => got.push(m));
    expect(sub.mocks.subscribe).toHaveBeenCalledTimes(2);
    sub.emit('run:r1:events', eventFrame('step', { seq: 2 }));
    expect(got).toHaveLength(1);

    await off();
    expect(sub.mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('退订后不再回调该处理器', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const got: SseMessage[] = [];
    const off = await bus.subscribe('r1', (m) => got.push(m));

    sub.emit('run:r1:events', eventFrame('step', { seq: 1 }));
    await off();
    sub.emit('run:r1:events', eventFrame('step', { seq: 2 }));

    expect(got).toHaveLength(1);
  });

  it('过滤坏帧', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const got: SseMessage[] = [];
    const off = await bus.subscribe('r1', (m) => got.push(m));

    // 坏 JSON、缺字段、非法事件名一律忽略。
    sub.emit('run:r1:events', '{not json');
    sub.emit('run:r1:events', JSON.stringify({ event: 'done' }));
    sub.emit('run:r1:events', eventFrame('bogus', {}));
    sub.emit('run:r1:events', eventFrame('step', { seq: 1 }));

    expect(got.map((m) => m.event)).toEqual(['step']);
    await off();
  });

  it('同步处理器抛错不影响连接与后续帧', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    let calls = 0;
    await bus.subscribe('r1', () => {
      calls += 1;
      throw new Error('subscriber boom');
    });
    expect(() => sub.emit('run:r1:events', eventFrame('step', {}))).not.toThrow();
    sub.emit('run:r1:events', eventFrame('done', {}));
    // 第一次抛错，第二次仍被分发。
    expect(calls).toBe(2);
  });

  it('异步处理器拒绝不影响同帧其他处理器与后续帧', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const got: SseMessage[] = [];

    await bus.subscribe('r1', async () => {
      throw new Error('async subscriber boom');
    });
    await bus.subscribe('r1', () => {
      throw new Error('sync subscriber boom');
    });
    await bus.subscribe('r1', (m) => got.push(m));

    sub.emit('run:r1:events', eventFrame('step', { seq: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toHaveLength(1);

    sub.emit('run:r1:events', eventFrame('done', {}));
    await Promise.resolve();
    expect(got.map((m) => m.event)).toEqual(['step', 'done']);
  });
});

describe('RedisRunControlBus', () => {
  it('publish 向 run:<id>:control 发送 JSON 帧', async () => {
    const publisher = fakePublisher();
    const bus = new RedisRunControlBus(
      publisher as unknown as Redis,
      () => {
        throw new Error('publish 不应创建订阅连接');
      },
    );
    await bus.publish('r1', { type: 'confirm', confirmId: 'c1', approved: false });
    expect(publisher.publish).toHaveBeenCalledWith(
      'run:r1:control',
      JSON.stringify({ type: 'confirm', confirmId: 'c1', approved: false }),
    );
  });

  it('订阅后消息 round-trip，非法控制帧忽略', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunControlBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const got: RunControlMessage[] = [];
    const off = await bus.subscribe('r1', (m) => got.push(m));

    sub.emit('run:r1:control', JSON.stringify({ type: 'cancel' }));
    sub.emit('run:r1:control', JSON.stringify({ type: 'confirm', confirmId: 'c1', approved: true }));
    sub.emit('run:r1:control', 'oops');
    sub.emit('run:r1:control', JSON.stringify({ type: 'confirm', confirmId: 'c2' }));
    sub.emit('run:r1:control', JSON.stringify({ type: 'resume' }));

    expect(got).toEqual([
      { type: 'cancel' },
      { type: 'confirm', confirmId: 'c1', approved: true },
    ]);
    await off();
  });

  it('同一运行共享连接，最后退订才解绑且幂等', async () => {
    const sub = createFakeSubscriber();
    const factory = vi.fn(() => sub.redis);
    const bus = new RedisRunControlBus(fakePublisher() as unknown as Redis, factory);
    const got: RunControlMessage[] = [];

    const offFirst = await bus.subscribe('r1', () => undefined);
    const offSecond = await bus.subscribe('r1', (m) => got.push(m));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sub.mocks.subscribe).toHaveBeenCalledTimes(1);

    await offFirst();
    await offFirst();
    expect(sub.mocks.unsubscribe).not.toHaveBeenCalled();
    sub.emit('run:r1:control', JSON.stringify({ type: 'cancel' }));
    expect(got).toHaveLength(1);

    await offSecond();
    await offSecond();
    expect(sub.mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.mocks.unsubscribe).toHaveBeenCalledWith('run:r1:control');
  });

  it('异步处理器拒绝不影响同帧其他处理器与后续帧', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunControlBus(fakePublisher() as unknown as Redis, () => sub.redis);
    const got: RunControlMessage[] = [];

    await bus.subscribe('r1', async () => {
      throw new Error('async control boom');
    });
    await bus.subscribe('r1', (m) => got.push(m));

    sub.emit('run:r1:control', JSON.stringify({ type: 'cancel' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toHaveLength(1);

    sub.emit('run:r1:control', JSON.stringify({ type: 'confirm', confirmId: 'c1', approved: false }));
    await Promise.resolve();
    expect(got).toEqual([
      { type: 'cancel' },
      { type: 'confirm', confirmId: 'c1', approved: false },
    ]);
  });
});
