import type { ModelPriceDto, RunBilling, UsageEvent } from '@ai-office/shared';
import { computeCredits } from '../billing/credits';
import type { BffMetrics } from './observability.metrics';

export interface ModelCredit {
  model: string;
  credits: number;
}

/** 合并同名模型用量，避免 usage 中出现重复条目时重复计费。 */
function mergeModels(models: UsageEvent['models']): UsageEvent['models'] {
  const acc = new Map<string, { input: number; output: number }>();
  for (const item of models) {
    const prev = acc.get(item.model) ?? { input: 0, output: 0 };
    prev.input += item.input;
    prev.output += item.output;
    acc.set(item.model, prev);
  }
  return [...acc].map(([model, usage]) => ({ model, ...usage }));
}

/**
 * 把整次运行的总积分按各模型折算成本比例分摊；最后一个模型吃掉舍入余数，
 * 保证分模型积分之和严格等于总积分。
 */
export function allocateModelCredits(
  models: UsageEvent['models'],
  prices: Record<string, ModelPriceDto>,
  cap: number,
): ModelCredit[] {
  const merged = mergeModels(models);
  const total = computeCredits(merged, prices, cap);
  if (total === 0 || merged.length === 0) return [];
  const scaled = merged.map((m) => {
    const p = prices[m.model];
    return {
      model: m.model,
      scaled: p ? m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k : 0,
    };
  });
  const sum = scaled.reduce((acc, item) => acc + item.scaled, 0);
  if (sum <= 0) return [{ model: merged[0].model, credits: total }];

  let remaining = total;
  const out: ModelCredit[] = [];
  for (let i = 0; i < scaled.length; i++) {
    const item = scaled[i];
    const credits =
      i === scaled.length - 1
        ? remaining
        : Math.min(remaining, Math.floor((total * item.scaled) / sum));
    remaining -= credits;
    if (credits > 0) out.push({ model: item.model, credits });
  }
  return out;
}

/** run 结束收尾：active gauge、终态计数、时长、token/积分；finish 幂等。 */
export class RunTelemetry {
  private finished = false;
  private forcedFailed = false;

  constructor(private readonly metrics: BffMetrics) {
    metrics.activeRuns.inc();
  }

  forceFail(): void {
    this.forcedFailed = true;
  }

  finish(
    status: 'done' | 'failed',
    usage: UsageEvent | null,
    billing: RunBilling,
    durationSeconds: number,
  ): void {
    if (this.finished) return;
    this.finished = true;
    const finalStatus = this.forcedFailed ? 'failed' : status;
    this.metrics.activeRuns.dec();
    this.metrics.runsTotal.inc({ status: finalStatus });
    this.metrics.runDuration.observe(Math.max(0, durationSeconds));

    if (!usage) return;
    for (const item of mergeModels(usage.models)) {
      this.metrics.modelTokens.inc({ model: item.model, type: 'input' }, item.input);
      this.metrics.modelTokens.inc({ model: item.model, type: 'output' }, item.output);
    }
    for (const item of allocateModelCredits(usage.models, billing.prices, billing.maxCredits)) {
      this.metrics.modelCredits.inc({ model: item.model }, item.credits);
    }
  }
}
