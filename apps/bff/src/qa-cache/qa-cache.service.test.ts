import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  normalizeQuestion,
  qaCacheHash,
  QaCacheService,
  QA_CACHE_INDEX_KEY,
  type QaCacheEntry,
} from './qa-cache.service';

interface FakeMulti {
  set(key: string, value: string, mode: 'EX', ttl: number): FakeMulti;
  zadd(key: string, score: number, member: string): FakeMulti;
  del(key: string): FakeMulti;
  zrem(key: string, member: string): FakeMulti;
  exec(): Promise<unknown[]>;
}

/** 只实现 QaCacheService 用到的命令；ZSET 用 Map 模拟，过期时间也要模拟。 */
function makeFakeRedis() {
  const strings = new Map<string, string>();
  const ttls = new Map<string, number>();
  const zsets = new Map<string, Map<string, number>>();
  const expireCalls: Array<{ key: string; ttl: number }> = [];
  const alive = (key: string): boolean => {
    const expiresAt = ttls.get(key);
    return expiresAt === undefined || expiresAt > Date.now();
  };
  const zindex = (): Map<string, number> => {
    let z = zsets.get(QA_CACHE_INDEX_KEY);
    if (!z) {
      z = new Map<string, number>();
      zsets.set(QA_CACHE_INDEX_KEY, z);
    }
    return z;
  };

  const multi = (): FakeMulti => {
    const queued: Array<() => void> = [];
    const builder: FakeMulti = {
      set(key, value, _mode, ttl) {
        expireCalls.push({ key, ttl });
        queued.push(() => {
          strings.set(key, value);
          ttls.set(key, Date.now() + ttl * 1000);
        });
        return builder;
      },
      zadd(_key, score, member) {
        queued.push(() => zindex().set(member, score));
        return builder;
      },
      del(key) {
        queued.push(() => {
          strings.delete(key);
          ttls.delete(key);
        });
        return builder;
      },
      zrem(_key, member) {
        queued.push(() => void zindex().delete(member));
        return builder;
      },
      async exec() {
        for (const run of queued) run();
        return [];
      },
    };
    return builder;
  };

  const redis = {
    multi,
    get: async (key: string) => (alive(key) ? (strings.get(key) ?? null) : null),
    mget: async (...keys: string[]) =>
      keys.map((key) => (alive(key) ? (strings.get(key) ?? null) : null)),
    del: async (key: string) => {
      ttls.delete(key);
      return strings.delete(key) ? 1 : 0;
    },
    zadd: async (_key: string, score: number, member: string) => {
      zindex().set(member, score);
      return 1;
    },
    zrem: async (_key: string, member: string) => (zindex().delete(member) ? 1 : 0),
    zcount: async (_key: string, min: string) => {
      const floor = Number(min);
      return [...zindex().values()].filter((score) => score >= floor).length;
    },
    zrangebyscore: async (
      _key: string,
      min: string,
      _max: string,
      _mode: string,
      offset: number,
      count: number,
    ) =>
      [...zindex().entries()]
        .filter(([, score]) => score >= Number(min))
        .sort((a, b) => a[1] - b[1])
        .slice(offset, offset + count)
        .map(([member]) => member),
    zremrangebyscore: async (_key: string, _min: string, max: string) => {
      let removed = 0;
      for (const [member, score] of [...zindex().entries()]) {
        if (score <= Number(max)) {
          zindex().delete(member);
          removed += 1;
        }
      }
      return removed;
    },
  };

  return { redis: redis as unknown as Redis, strings, ttls, zindex, expireCalls };
}

type FakeRedis = ReturnType<typeof makeFakeRedis>;

function makeService() {
  const fake = makeFakeRedis();
  return { svc: new QaCacheService(fake.redis), fake };
}

function seedEntry(
  fake: FakeRedis,
  hash: string,
  expiresAt: number,
  overrides: Partial<QaCacheEntry> = {},
): void {
  const entry: QaCacheEntry = {
    tenantId: 't1',
    userId: 'u1',
    sessionId: 's1',
    question: '问题',
    answer: '答案',
    createdAt: expiresAt - 60_000,
    expiresAt,
    ...overrides,
  };
  fake.strings.set(`qa:cache:entry:${hash}`, JSON.stringify(entry));
  fake.ttls.set(`qa:cache:entry:${hash}`, expiresAt);
  fake.zindex().set(hash, expiresAt);
}

const baseParams = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  question: '写个总结',
  ttlSeconds: 120,
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('normalizeQuestion / qaCacheHash', () => {
  it('去首尾空白、折叠连续空白并转小写', () => {
    expect(normalizeQuestion('  Hello   World  ')).toBe('hello world');
  });

  it('用户、会话或问题任一不同，hash 都不同', () => {
    const base = qaCacheHash('u1', 's1', 'hello world');
    expect(qaCacheHash('u2', 's1', 'hello world')).not.toBe(base);
    expect(qaCacheHash('u1', 's2', 'hello world')).not.toBe(base);
    expect(qaCacheHash('u1', 's1', 'hello world!')).not.toBe(base);
    // 规范化后相同的问题共用同一个键。
    expect(qaCacheHash('u1', 's1', '  HELLO   world ')).toBe(base);
  });
});

describe('QaCacheService', () => {
  it('写入后可命中，且只有同一用户、同一会话能读到', async () => {
    const { svc } = makeService();
    await svc.remember({ ...baseParams, answer: '这是答案' });

    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's1', question: '  写个   总结 ' }),
    ).resolves.toMatchObject({ answer: '这是答案' });
    await expect(
      svc.lookup({ userId: 'u2', sessionId: 's1', question: '写个总结' }),
    ).resolves.toBeNull();
    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's2', question: '写个总结' }),
    ).resolves.toBeNull();
  });

  it('写入使用传入的 TTL，并同步过期时间索引', async () => {
    const { svc, fake } = makeService();
    vi.useFakeTimers({ now: new Date('2026-10-27T00:00:00Z') });
    try {
      await svc.remember({ ...baseParams, answer: '答案', ttlSeconds: 120 });
      const hash = qaCacheHash('u1', 's1', '写个总结');
      expect(fake.expireCalls).toEqual([{ key: `qa:cache:entry:${hash}`, ttl: 120 }]);
      expect(fake.zindex().get(hash)).toBe(Date.parse('2026-10-27T00:02:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('再次成功运行会覆盖旧答案并从当前时刻重新计时', async () => {
    const { svc } = makeService();
    vi.useFakeTimers({ now: new Date('2026-10-27T00:00:00Z') });
    try {
      await svc.remember({ ...baseParams, answer: '旧答案', ttlSeconds: 60 });
      vi.setSystemTime(new Date('2026-10-27T00:00:30Z'));
      await svc.remember({ ...baseParams, answer: '新答案', ttlSeconds: 120 });

      const entry = await svc.lookup({ userId: 'u1', sessionId: 's1', question: '写个总结' });
      expect(entry).toMatchObject({
        answer: '新答案',
        expiresAt: Date.parse('2026-10-27T00:02:30Z'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('问题或答案为空时不写入', async () => {
    const { svc, fake } = makeService();
    await svc.remember({ ...baseParams, question: '   ', answer: '答案' });
    await svc.remember({ ...baseParams, answer: '   ' });
    expect(fake.expireCalls).toHaveLength(0);
  });

  it('删除后条目与索引都不再存在', async () => {
    const { svc, fake } = makeService();
    await svc.remember({ ...baseParams, answer: '答案' });
    const hash = qaCacheHash('u1', 's1', '写个总结');

    await svc.remove(hash);

    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's1', question: '写个总结' }),
    ).resolves.toBeNull();
    expect(fake.zindex().has(hash)).toBe(false);
  });

  it('列表只返回未过期条目，按过期时间升序并支持分页', async () => {
    const { svc, fake } = makeService();
    const now = Date.now();
    const h1 = qaCacheHash('u1', 's1', '问题一');
    const h2 = qaCacheHash('u1', 's1', '问题二');
    const h3 = qaCacheHash('u1', 's1', '问题三');
    seedEntry(fake, h1, now + 3_000, { answer: '答案一' });
    seedEntry(fake, h2, now + 1_000, { answer: '答案二' });
    seedEntry(fake, h3, now - 1_000, { answer: '已过期' });

    const first = await svc.list({ offset: 0, limit: 2 });
    expect(first.total).toBe(2);
    expect(first.items.map((item) => item.hash)).toEqual([h2, h1]);

    const second = await svc.list({ offset: 1, limit: 1 });
    expect(second.items.map((item) => item.hash)).toEqual([h1]);

    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's1', question: '问题三' }),
    ).resolves.toBeNull();
  });

  it('条目已被 TTL 删除但索引残留时，列表跳过并移除索引', async () => {
    const { svc, fake } = makeService();
    const now = Date.now();
    const stale = qaCacheHash('u1', 's1', '残留');
    seedEntry(fake, stale, now + 60_000);
    fake.strings.delete(`qa:cache:entry:${stale}`);

    const result = await svc.list({ offset: 0, limit: 10 });

    expect(result.items).toEqual([]);
    expect(fake.zindex().has(stale)).toBe(false);
  });

  it('损坏 JSON 视为未命中并删除条目与索引', async () => {
    const { svc, fake } = makeService();
    const hash = qaCacheHash('u1', 's1', '坏数据');
    fake.strings.set(`qa:cache:entry:${hash}`, 'not-json');
    fake.zindex().set(hash, Date.now() + 60_000);

    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's1', question: '坏数据' }),
    ).resolves.toBeNull();
    expect(fake.strings.has(`qa:cache:entry:${hash}`)).toBe(false);
    expect(fake.zindex().has(hash)).toBe(false);
  });

  it('条目属主与查询参数不一致时视为未命中并删除', async () => {
    const { svc, fake } = makeService();
    const hash = qaCacheHash('u1', 's1', '串号');
    seedEntry(fake, hash, Date.now() + 60_000, { userId: 'u2' });

    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's1', question: '串号' }),
    ).resolves.toBeNull();
    expect(fake.zindex().has(hash)).toBe(false);
  });

  it('未配置 Redis 时读写静默跳过，管理端方法返回 503', async () => {
    const svc = new QaCacheService(null);
    expect(svc.available).toBe(false);
    await expect(
      svc.lookup({ userId: 'u1', sessionId: 's1', question: '问题' }),
    ).resolves.toBeNull();
    await expect(
      svc.remember({ ...baseParams, answer: '答案' }),
    ).resolves.toBeUndefined();
    await expect(svc.list({ offset: 0, limit: 20 })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(svc.get('a'.repeat(64))).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.remove('a'.repeat(64))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
