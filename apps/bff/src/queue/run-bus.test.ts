import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SseMessage } from '@ai-office/shared';
import { LocalRunEventBus, RedisRunEventBus } from './run-event-bus';
import { LocalRunControlBus, RedisRunControlBus, type RunControlMessage } from './run-control-bus';

/** 假的订阅连接：记录 subscribe/unsubscribe/disconnect，并允许手工投递 message 帧。 */
function createFakeSubscriber() {
  let messageListener: ((channel: string, raw: string) => void) | undefined;
  const redis = {
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 0),
    disconnect: vi.fn(),
    on: vi.fn((event: string, listener: (channel: string, raw: string) => void) => {
      if (event === 'message') messageListener = listener;
      return redis;
    }),
  };
  return {
    redis: redis as unknown as Redis,
    emit(channel: string, raw: string) {
      messageListener?.(channel, raw);
    },
    listenerReady: () => messageListener !== undefined,
  };
}

function fakePublisher() {
  return { publish: vi.fn(async () => 1) };
}

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

  it('subscribe 使用独立连接、过滤坏帧，退订释放连接', async () => {
    const publisher = fakePublisher();
    const sub = createFakeSubscriber();
    const factory = vi.fn(() => sub.redis);
    const bus = new RedisRunEventBus(publisher as unknown as Redis, factory);
    const got: SseMessage[] = [];

    const off = await bus.subscribe('r1', (m) => got.push(m));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sub.redis.subscribe).toHaveBeenCalledWith('run:r1:events');
    expect(sub.listenerReady()).toBe(true);

    sub.emit('run:r1:events', JSON.stringify({ event: 'done', data: { runId: 'r1' } }));
    // 坏 JSON、缺字段、非法事件名一律忽略。
    sub.emit('run:r1:events', '{not json');
    sub.emit('run:r1:events', JSON.stringify({ event: 'done' }));
    sub.emit('run:r1:events', JSON.stringify({ event: 'bogus', data: {} }));
    sub.emit('run:r1:events', JSON.stringify({ event: 'step', data: { seq: 1 } }));

    expect(got.map((m) => m.event)).toEqual(['done', 'step']);

    await off();
    expect(sub.redis.unsubscribe).toHaveBeenCalledWith('run:r1:events');
    expect(sub.redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('订阅者抛错不影响连接与后续帧', async () => {
    const sub = createFakeSubscriber();
    const bus = new RedisRunEventBus(fakePublisher() as unknown as Redis, () => sub.redis);
    let calls = 0;
    await bus.subscribe('r1', () => {
      calls += 1;
      throw new Error('subscriber boom');
    });
    expect(() => sub.emit('run:r1:events', JSON.stringify({ event: 'step', data: {} }))).not.toThrow();
    sub.emit('run:r1:events', JSON.stringify({ event: 'done', data: {} }));
    // 第一次抛错，第二次仍被分发。
    expect(calls).toBe(2);
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

  it('订阅后消息 round-trip，非法控制帧忽略，退订释放连接', async () => {
    const sub = createFakeSubscriber();
    const factory = vi.fn(() => sub.redis);
    const bus = new RedisRunControlBus(fakePublisher() as unknown as Redis, factory);
    const got: RunControlMessage[] = [];

    const off = await bus.subscribe('r1', (m) => got.push(m));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sub.redis.subscribe).toHaveBeenCalledWith('run:r1:control');

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
    expect(sub.redis.unsubscribe).toHaveBeenCalledWith('run:r1:control');
    expect(sub.redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
