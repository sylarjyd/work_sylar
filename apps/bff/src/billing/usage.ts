import type { UsageAggregateDto, UsageEvent } from '@ai-office/shared';

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

/** 校验并解析 runtime 的 usage 事件；非法结构返回 null（不扣费）。 */
export function parseUsageEvent(data: unknown): UsageEvent | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.input !== 'number' || typeof d.output !== 'number' || !Array.isArray(d.models)) {
    return null;
  }
  return { input: d.input, output: d.output, models: parseModels(d.models) };
}

/** 从 JSON 字段提取模型用量，过滤非法项。 */
export function parseModels(raw: unknown): ModelUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelUsage[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.model !== 'string' || typeof m.input !== 'number' || typeof m.output !== 'number') {
      continue;
    }
    out.push({ model: m.model, input: m.input, output: m.output });
  }
  return out;
}

export interface UsageRow {
  createdAt: Date;
  credits: number | null;
  inputTokens: number;
  outputTokens: number;
  models: unknown;
}

/**
 * 用量聚合：按日时 credits 取结算值；按模型时用价格表单独折算
 * （不做“最低 1 积分”，否则每个模型都会被抬高）。
 */
export function aggregateUsage(
  rows: UsageRow[],
  groupBy: 'day' | 'model',
  prices: Record<string, { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number }>,
): UsageAggregateDto[] {
  const acc = new Map<string, UsageAggregateDto>();
  // 按模型聚合时先累计毫积分，最后统一折算，避免逐行取整把积分抬高。
  const scaledCredits = new Map<string, number>();
  const add = (key: string, credits: number, input: number, output: number) => {
    const cur = acc.get(key) ?? { key, credits: 0, inputTokens: 0, outputTokens: 0, runs: 0 };
    cur.credits += credits;
    cur.inputTokens += input;
    cur.outputTokens += output;
    cur.runs += 1;
    acc.set(key, cur);
  };

  for (const row of rows) {
    if (groupBy === 'day') {
      add(row.createdAt.toISOString().slice(0, 10), row.credits ?? 0, row.inputTokens, row.outputTokens);
    } else {
      for (const m of parseModels(row.models)) {
        const p = prices[m.model];
        const scaled = p ? m.input * p.inputMilliCreditsPer1k + m.output * p.outputMilliCreditsPer1k : 0;
        scaledCredits.set(m.model, (scaledCredits.get(m.model) ?? 0) + scaled);
        add(m.model, 0, m.input, m.output);
      }
    }
  }
  if (groupBy === 'model') {
    for (const [key, scaled] of scaledCredits) {
      const item = acc.get(key);
      if (item) item.credits = Math.ceil(scaled / 1_000_000);
    }
  }
  return [...acc.values()].sort((a, b) => a.key.localeCompare(b.key));
}
