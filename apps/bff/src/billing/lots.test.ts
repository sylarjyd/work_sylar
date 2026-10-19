import { describe, it, expect } from 'vitest';
import { sortLots, allocate } from './lots';

const d = (s: string) => new Date(s);

describe('sortLots', () => {
  it('最早到期优先；同到期 base → bonus → pack；NULL 最后', () => {
    const lots = [
      { id: 'pack', source: 'pack', remaining: 10, expiresAt: d('2026-12-01') },
      { id: 'never', source: 'adjust', remaining: 10, expiresAt: null },
      { id: 'bonus', source: 'bonus', remaining: 10, expiresAt: d('2026-12-01') },
      { id: 'base', source: 'base', remaining: 10, expiresAt: d('2026-12-01') },
      { id: 'early', source: 'base', remaining: 10, expiresAt: d('2026-10-20') },
    ];
    expect(sortLots(lots).map((l) => l.id)).toEqual(['early', 'base', 'bonus', 'pack', 'never']);
  });

  it('更早到期的 pack 优先于 base', () => {
    const lots = [
      { id: 'base', source: 'base', remaining: 5, expiresAt: d('2026-12-01') },
      { id: 'pack', source: 'pack', remaining: 5, expiresAt: d('2026-11-01') },
    ];
    expect(sortLots(lots).map((l) => l.id)).toEqual(['pack', 'base']);
  });
});

describe('allocate', () => {
  it('按顺序扣减并返回明细', () => {
    const lots = [
      { id: 'b', source: 'base', remaining: 5, expiresAt: d('2026-12-01') },
      { id: 'a', source: 'base', remaining: 5, expiresAt: d('2026-10-20') },
    ];
    expect(allocate(lots, 7)).toEqual({
      allocations: [
        { lotId: 'a', amount: 5 },
        { lotId: 'b', amount: 2 },
      ],
      deducted: 7,
    });
  });

  it('余额不足时按可用额度扣减', () => {
    expect(
      allocate([{ id: 'a', source: 'base', remaining: 3, expiresAt: null }], 10),
    ).toEqual({ allocations: [{ lotId: 'a', amount: 3 }], deducted: 3 });
  });
});
