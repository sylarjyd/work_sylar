export interface LotLike {
  id: string;
  source: string;
  remaining: number;
  expiresAt: Date | null;
}

const SOURCE_ORDER: Record<string, number> = { base: 0, bonus: 1, pack: 2 };

/** 扣减顺序：最早到期优先；NULL 视为永不过期排最后；同到期 base → bonus → pack → 其他。 */
export function sortLots<T extends LotLike>(lots: T[]): T[] {
  return [...lots].sort((a, b) => {
    const ax = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY;
    const bx = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY;
    if (ax !== bx) return ax - bx;
    const ao = SOURCE_ORDER[a.source] ?? 3;
    const bo = SOURCE_ORDER[b.source] ?? 3;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

export interface LotAllocation {
  lotId: string;
  amount: number;
}

/** 从批次中扣减 amount；返回逐批明细与实际扣减总额（不足时按可用额度封顶）。 */
export function allocate(
  lots: LotLike[],
  amount: number,
): { allocations: LotAllocation[]; deducted: number } {
  let left = Math.max(0, amount);
  const allocations: LotAllocation[] = [];
  for (const lot of sortLots(lots)) {
    if (left <= 0) break;
    if (lot.remaining <= 0) continue;
    const take = Math.min(lot.remaining, left);
    allocations.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return { allocations, deducted: Math.max(0, amount) - left };
}
