import type { ModelPriceDto } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/**
 * 积分 = ceil(Σ tokens × 毫积分/1K ÷ 1000 ÷ 1000)，最低 1，封顶为 cap。
 * cap <= 0 时返回 0，避免无可用额度时仍扣费、破坏 reserved <= balance 不变量。
 * 全程整数累计后再除，避免浮点误差。
 */
export function computeCredits(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
  cap: number,
): number {
  let scaled = 0;
  for (const m of models) {
    const p = prices[m.model];
    if (!p) continue;
    scaled += m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k;
  }
  const limit = Math.max(0, Math.floor(cap));
  if (limit === 0) return 0;
  // 有可用额度时最低扣 1（避免极小用量长期免费），但绝不突破上限。
  return Math.min(Math.max(1, Math.ceil(scaled / 1_000_000)), limit);
}
