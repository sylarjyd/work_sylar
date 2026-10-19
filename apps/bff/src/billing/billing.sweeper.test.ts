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
