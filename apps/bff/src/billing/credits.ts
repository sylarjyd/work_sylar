import type { ModelPriceDto } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/**
 * 积分 = ceil(Σ tokens × 毫积分/1K ÷ 1000 ÷ 1000)，最低 1，封顶 cap。
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
  const credits = Math.max(1, Math.ceil(scaled / 1_000_000));
  return Math.min(credits, Math.max(1, cap));
}
