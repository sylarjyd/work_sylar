import type { ModelPriceDto, UsageEvent } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/** 未折算的整数分子：Σ tokens × 费率；与 maxCredits × 1_000_000 比较可避免浮点误差。 */
export function scaledValue(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
): number {
  let scaled = 0;
  for (const m of models) {
    const p = prices[m.model];
    if (!p) continue;
    scaled += m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k;
  }
  return scaled;
}

/** 累计用量换算成毫积分：tokens × 毫积分/1K ÷ 1000。 */
export function milliCreditsFor(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
): number {
  return scaledValue(models, prices) / 1000;
}

/** Map<model, usage> → usage 事件（累计值）。 */
export function toUsageEvent(map: Map<string, { input: number; output: number }>): UsageEvent {
  let input = 0;
  let output = 0;
  const models: ModelUsage[] = [];
  for (const [model, u] of map) {
    input += u.input;
    output += u.output;
    models.push({ model, input: u.input, output: u.output });
  }
  return { input, output, models };
}
