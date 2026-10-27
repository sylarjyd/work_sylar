import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { PreparedMessage } from '../attachments/attachments.service';
import {
  MIN_RECENT_MESSAGES,
  ShortTermMemoryService,
  computeCut,
  fallbackSummary,
  lockKey,
  stateKey,
} from './short-term-memory.service';

function msg(content: string, role: PreparedMessage['role'] = 'user'): PreparedMessage {
  return { role, content, attachments: [] };
}

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(
      async (_script: string, _keys: number, key: string, value: string) => {
        if (store.get(key) === value) {
          store.delete(key);
          return 1;
        }
        return 0;
      },
    ),
  };
}

describe('computeCut', () => {
  it('预算充足时保留全部历史', () => {
    expect(computeCut([msg('一'), msg('二'), msg('三')], 1000)).toBe(0);
  });

  it('预算不足时至少保留最近 4 条', () => {
    const messages = Array.from({ length: 10 }, () => msg('x'.repeat(100)));
    expect(computeCut(messages, 250)).toBe(6);
  });

  it('单条消息超预算时窗口固定为最近 4 条，不继续丢历史', () => {
    const messages = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e'.repeat(5000))];
    expect(computeCut(messages, 100)).toBe(messages.length - MIN_RECENT_MESSAGES);
  });

  it('按 Unicode 码点计数：中文与 emoji 不按代理对放大', () => {
    const messages = Array.from({ length: 5 }, () => msg('😀'.repeat(10)));
    expect(computeCut(messages, 45)).toBe(1);
  });
});

describe('fallbackSummary', () => {
  it('逐条截断并在超长时从最旧开始丢弃', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(`消息${i}-` + 'x'.repeat(300)),
    );
    const summary = fallbackSummary(messages);
    expect(Array.from(summary).length).toBeLessThanOrEqual(2000);
    expect(summary).toContain('消息11-');
    expect(summary).not.toContain('消息0-');
  });

  it('保留旧摘要作为开头', () => {
    const summary = fallbackSummary([msg('新增内容')], '已有摘要');
    expect(summary.startsWith('已有摘要')).toBe(true);
    expect(summary).toContain('用户: 新增内容');
  });
});

describe('ShortTermMemoryService', () => {
  it('Redis 缺席时 available=false 且读取返回 null', async () => {
    const svc = new ShortTermMemoryService(null);
    expect(svc.available).toBe(false);
    await expect(svc.load('s1')).resolves.toBeNull();
  });

  it('保存状态带 30 天 TTL，且能读回', async () => {
    const redis = fakeRedis();
    const svc = new ShortTermMemoryService(redis as unknown as Redis);
    await svc.save('s1', { summary: '摘要', upToCount: 3, updatedAt: 1 });
    expect(redis.set).toHaveBeenCalledWith(
      stateKey('s1'),
      expect.any(String),
      'EX',
      2_592_000,
    );
    await expect(svc.load('s1')).resolves.toEqual({
      summary: '摘要',
      upToCount: 3,
      updatedAt: 1,
    });
  });

  it('损坏状态视为无状态', async () => {
    const redis = fakeRedis();
    redis.store.set(stateKey('s1'), '{bad json');
    const svc = new ShortTermMemoryService(redis as unknown as Redis);
    await expect(svc.load('s1')).resolves.toBeNull();
  });

  it('锁按 NX 排他，只释放自己持有的 runId', async () => {
    const redis = fakeRedis();
    const svc = new ShortTermMemoryService(redis as unknown as Redis);
    await expect(svc.tryLock('s1', 'r1')).resolves.toBe(true);
    await expect(svc.tryLock('s1', 'r2')).resolves.toBe(false);
    await svc.unlock('s1', 'r2');
    expect(redis.store.has(lockKey('s1'))).toBe(true);
    await svc.unlock('s1', 'r1');
    expect(redis.store.has(lockKey('s1'))).toBe(false);
  });
});
