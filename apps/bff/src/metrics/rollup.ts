import type { ModelPriceDto } from '@ai-office/shared';
import { boundedLabel } from '@ai-office/telemetry';

export type MetricDimensionType = 'global' | 'model' | 'tenant' | 'tool';

/** 与 Prisma MetricBucket 一一对应；bucketStart 为整点 UTC。 */
export interface MetricBucketInput {
  bucketStart: Date;
  metric: string;
  dimensionType: MetricDimensionType;
  dimensionId: string;
  value: number;
  count: number;
}

export interface RunStartRow {
  tenantId: string;
  startedAt: Date;
}

export interface RunEndRow {
  tenantId: string;
  status: string;
  startedAt: Date;
  endedAt: Date;
}

export interface UsageRollupRow {
  tenantId: string;
  models: unknown;
  inputTokens: number;
  outputTokens: number;
  credits: number | null;
}

export interface ToolStepRow {
  payload: unknown;
}

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
}

export const HOUR_MS = 3_600_000;

/** 按 UTC 对齐到整点。 */
export function hourStartOf(value: Date): Date {
  const d = new Date(value);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function inHour(value: Date, bucketStart: Date): boolean {
  const ts = value.getTime();
  return ts >= bucketStart.getTime() && ts < bucketStart.getTime() + HOUR_MS;
}

type Acc = Map<string, MetricBucketInput>;

function add(
  acc: Acc,
  bucketStart: Date,
  metric: string,
  dimensionType: MetricDimensionType,
  dimensionId: string,
  value: number,
  count = 0,
): void {
  const key = `${metric} ${dimensionType} ${dimensionId}`;
  const current = acc.get(key);
  if (current) {
    current.value += value;
    current.count += count;
    return;
  }
  acc.set(key, { bucketStart, metric, dimensionType, dimensionId, value, count });
}

/** 固定排序：同一小时重复重算时，写库顺序与结果稳定，便于测试和排障。 */
function finish(acc: Acc): MetricBucketInput[] {
  return [...acc.values()].sort(
    (a, b) =>
      a.metric.localeCompare(b.metric) ||
      a.dimensionType.localeCompare(b.dimensionType) ||
      a.dimensionId.localeCompare(b.dimensionId),
  );
}

export function aggregateRunStarts(
  rows: RunStartRow[],
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    if (!inHour(row.startedAt, bucketStart)) continue;
    add(acc, bucketStart, 'runs_started', 'global', '', 1);
    if (row.tenantId) add(acc, bucketStart, 'runs_started', 'tenant', row.tenantId, 1);
  }
  return finish(acc);
}

export function aggregateRunEnds(
  rows: RunEndRow[],
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    if (!inHour(row.endedAt, bucketStart)) continue;
    if (row.status === 'done') {
      add(acc, bucketStart, 'runs_done', 'global', '', 1);
      if (row.tenantId) add(acc, bucketStart, 'runs_done', 'tenant', row.tenantId, 1);
    } else if (row.status === 'failed') {
      add(acc, bucketStart, 'runs_failed', 'global', '', 1);
      if (row.tenantId) add(acc, bucketStart, 'runs_failed', 'tenant', row.tenantId, 1);
    } else {
      // running 等非终态没有 endedAt 语义，跳过。
      continue;
    }

    // 负时长只可能来自时钟回拨/脏数据，按 0 记，避免快照出现负值。
    const durationMs = Math.max(0, row.endedAt.getTime() - row.startedAt.getTime());
    add(acc, bucketStart, 'run_duration_ms', 'global', '', durationMs, 1);
    if (row.tenantId) {
      add(acc, bucketStart, 'run_duration_ms', 'tenant', row.tenantId, durationMs, 1);
    }
  }
  return finish(acc);
}

export function parseModelUsage(raw: unknown): ModelUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelUsage[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.model !== 'string' || row.model === '') continue;
    const input =
      typeof row.input === 'number' && Number.isFinite(row.input) && row.input > 0
        ? row.input
        : 0;
    const output =
      typeof row.output === 'number' && Number.isFinite(row.output) && row.output > 0
        ? row.output
        : 0;
    if (input === 0 && output === 0) continue;
    out.push({ model: boundedLabel(row.model), input, output });
  }
  return out;
}

/**
 * 把一条用量记录的实际积分按当前价格权重分摊到模型；权重缺失时全部落到
 * 第一个模型，保证分模型积分之和严格等于记录积分。
 */
export function allocateModelCredits(
  models: ModelUsage[],
  prices: Record<string, ModelPriceDto>,
  totalCredits: number,
): Array<{ model: string; credits: number }> {
  if (models.length === 0 || totalCredits <= 0) return [];
  const weights = models.map((m) => {
    const price = prices[m.model];
    return price
      ? m.input * price.inputMilliCreditsPer1k + m.output * price.outputMilliCreditsPer1k
      : 0;
  });
  const sum = weights.reduce((acc, item) => acc + item, 0);
  if (sum <= 0) return [{ model: models[0].model, credits: totalCredits }];

  const out: Array<{ model: string; credits: number }> = [];
  let remaining = totalCredits;
  for (let i = 0; i < models.length; i++) {
    const credits =
      i === models.length - 1
        ? remaining
        : Math.min(remaining, Math.floor((totalCredits * weights[i]) / sum));
    remaining -= credits;
    if (credits > 0) out.push({ model: models[i].model, credits });
  }
  return out;
}

export function aggregateUsage(
  rows: UsageRollupRow[],
  prices: Record<string, ModelPriceDto>,
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    add(acc, bucketStart, 'input_tokens', 'global', '', row.inputTokens);
    add(acc, bucketStart, 'output_tokens', 'global', '', row.outputTokens);
    if (row.tenantId) {
      add(acc, bucketStart, 'input_tokens', 'tenant', row.tenantId, row.inputTokens);
      add(acc, bucketStart, 'output_tokens', 'tenant', row.tenantId, row.outputTokens);
    }

    const models = parseModelUsage(row.models);
    for (const model of models) {
      add(acc, bucketStart, 'input_tokens', 'model', model.model, model.input);
      add(acc, bucketStart, 'output_tokens', 'model', model.model, model.output);
    }

    if (row.credits !== null && row.credits > 0) {
      add(acc, bucketStart, 'credits', 'global', '', row.credits);
      if (row.tenantId) add(acc, bucketStart, 'credits', 'tenant', row.tenantId, row.credits);
      for (const item of allocateModelCredits(models, prices, row.credits)) {
        add(acc, bucketStart, 'credits', 'model', item.model, item.credits);
      }
    }
  }
  return finish(acc);
}

export function parseToolResult(payload: unknown): { tool: string; ok: boolean } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.tool !== 'string' || row.tool === '') return null;
  return { tool: boundedLabel(row.tool), ok: row.ok === true };
}

export function aggregateToolCalls(
  rows: ToolStepRow[],
  bucketStart: Date,
): MetricBucketInput[] {
  const acc: Acc = new Map();
  for (const row of rows) {
    const result = parseToolResult(row.payload);
    if (!result) continue;
    add(acc, bucketStart, 'tool_calls', 'tool', result.tool, 1);
    if (!result.ok) add(acc, bucketStart, 'tool_failures', 'tool', result.tool, 1);
  }
  return finish(acc);
}
