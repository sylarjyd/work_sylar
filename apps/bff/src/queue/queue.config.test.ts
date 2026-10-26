import { describe, expect, it } from 'vitest';
import { readQueueConfig } from './queue.config';

describe('readQueueConfig', () => {
  it('无 REDIS_URL 时关闭队列', () => {
    const config = readQueueConfig({});
    expect(config.enabled).toBe(false);
    expect(config.redisUrl).toBeNull();
    expect(config.name).toBe('runs');
    expect(config.concurrency).toBe(4);
  });

  it('RUN_QUEUE_ENABLED=0 强制内联', () => {
    expect(readQueueConfig({ REDIS_URL: 'redis://x', RUN_QUEUE_ENABLED: '0' }).enabled).toBe(false);
  });

  it('空白 REDIS_URL 视为未配置', () => {
    expect(readQueueConfig({ REDIS_URL: '   ' }).enabled).toBe(false);
  });

  it('并发数夹取到 1–32', () => {
    expect(readQueueConfig({ REDIS_URL: 'redis://x', RUN_QUEUE_CONCURRENCY: '999' }).concurrency).toBe(32);
    expect(readQueueConfig({ REDIS_URL: 'redis://x', RUN_QUEUE_CONCURRENCY: '0' }).concurrency).toBe(1);
  });

  it('非法并发数回落默认值', () => {
    expect(readQueueConfig({ REDIS_URL: 'redis://x', RUN_QUEUE_CONCURRENCY: 'abc' }).concurrency).toBe(4);
    expect(readQueueConfig({ REDIS_URL: 'redis://x', RUN_QUEUE_CONCURRENCY: '3.5' }).concurrency).toBe(4);
  });

  it('自定义队列名并去除空白', () => {
    const config = readQueueConfig({ REDIS_URL: 'redis://x', RUN_QUEUE_NAME: '  my-runs  ' });
    expect(config.name).toBe('my-runs');
  });
});
