import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BillingSweeper } from './billing.sweeper';
import type { BillingService } from './billing.service';

describe('BillingSweeper.tick', () => {
  it('每分钟结算陈旧 pending，并扫描孤儿预占；异常不外抛', async () => {
    const calls: string[] = [];
    const billing = {
      settleStalePending: async () => { calls.push('stale'); },
      sweepOrphanHolds: async () => { calls.push('holds'); },
      sweepExpired: async () => { calls.push('expired'); },
    } as unknown as BillingService;
    const sweeper = new BillingSweeper(billing);
    await sweeper.tick();
    expect(calls).toContain('stale');
    expect(calls).toContain('holds');
  });

  it('首次 tick 做过期扫描，后续 tick 未见满 24h 不重复扫描', async () => {
    const calls: string[] = [];
    const billing = {
      settleStalePending: async () => undefined,
      sweepOrphanHolds: async () => undefined,
      sweepExpired: async () => { calls.push('expired'); },
    } as unknown as BillingService;
    const sweeper = new BillingSweeper(billing);
    await sweeper.tick();
    await sweeper.tick();
    expect(calls.filter((c) => c === 'expired')).toHaveLength(1);
  });

  it('上一轮未结束时重入的 tick 直接跳过', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let staleCalls = 0;
    const billing = {
      settleStalePending: async () => { staleCalls += 1; await gate; },
      sweepOrphanHolds: async () => undefined,
      sweepExpired: async () => undefined,
    } as unknown as BillingService;
    const sweeper = new BillingSweeper(billing);

    const first = sweeper.tick();
    await sweeper.tick();
    expect(staleCalls).toBe(1);

    release();
    await first;
  });

  it('单个扫描失败不向外抛', async () => {
    const billing = {
      settleStalePending: async () => { throw new Error('db down'); },
      sweepOrphanHolds: async () => undefined,
      sweepExpired: async () => undefined,
    } as unknown as BillingService;
    await expect(new BillingSweeper(billing).tick()).resolves.toBeUndefined();
  });

  it('onModuleDestroy 可重复调用不抛错', () => {
    const billing = {
      settleStalePending: async () => undefined,
      sweepOrphanHolds: async () => undefined,
      sweepExpired: async () => undefined,
    } as unknown as BillingService;
    const sweeper = new BillingSweeper(billing);
    expect(() => {
      sweeper.onModuleDestroy();
      sweeper.onModuleDestroy();
    }).not.toThrow();
  });
});
