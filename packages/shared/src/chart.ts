/**
 * 图表规格：模型只表达「数据 + 少量样式」，由前端转成 ECharts option。
 * 不接受任意 option 对象，避免模型注入回调/超长配置，也保证各端渲染一致。
 */
export const CHART_KINDS = ['line', 'bar', 'area', 'pie', 'scatter'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const CHART_LIMITS = {
  maxCategories: 200,
  maxSeries: 8,
  maxTitleLength: 120,
  maxLabelLength: 40,
  maxSeriesNameLength: 40,
} as const;

export interface ChartSeriesSpec {
  name: string;
  /** 与 categories 等长；缺失或非法值用 null 表示断点。 */
  data: Array<number | null>;
}

export interface ChartSpec {
  kind: ChartKind;
  categories: string[];
  series: ChartSeriesSpec[];
  title?: string;
  yName?: string;
  stacked?: boolean;
  horizontal?: boolean;
}

export function isChartKind(value: unknown): value is ChartKind {
  return typeof value === 'string' && (CHART_KINDS as readonly string[]).includes(value);
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function literal(value: unknown, maxLength: number): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, maxLength);
  }
  return text(value, maxLength);
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 校验并收敛模型给的图表参数；结构不合法返回 null（调用方据此报错，而不是画一张错图）。
 * 超长数据按上限截断而非报错：图表本身就是抽样展示，截断比整张图失败更有用。
 */
export function normalizeChartSpec(input: unknown): ChartSpec | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (!isChartKind(kind)) return null;

  const categories = Array.isArray(raw.categories)
    ? raw.categories
        .map((item) => literal(item, CHART_LIMITS.maxLabelLength))
        .filter((item): item is string => item !== undefined)
        .slice(0, CHART_LIMITS.maxCategories)
    : [];
  if (categories.length === 0) return null;
  // 饼图一个扇区没有意义，至少要有两组对比。
  if (kind === 'pie' && categories.length < 2) return null;

  const seriesRaw = Array.isArray(raw.series) ? raw.series : [];
  const series: ChartSeriesSpec[] = [];
  for (const item of seriesRaw.slice(0, CHART_LIMITS.maxSeries)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const data = Array.isArray(row.data) ? row.data : [];
    if (data.length === 0) continue;
    const values: Array<number | null> = [];
    for (let i = 0; i < categories.length; i += 1) values.push(toNumber(data[i]));
    series.push({
      name: text(row.name, CHART_LIMITS.maxSeriesNameLength) ?? `系列 ${series.length + 1}`,
      data: values,
    });
    // 饼图只画一个系列，多给的忽略，避免出现同心饼。
    if (kind === 'pie') break;
  }
  if (series.length === 0) return null;

  const spec: ChartSpec = { kind, categories, series };
  const title = text(raw.title, CHART_LIMITS.maxTitleLength);
  if (title) spec.title = title;
  const yName = text(raw.yName, CHART_LIMITS.maxLabelLength);
  if (yName) spec.yName = yName;
  if (raw.stacked === true && kind !== 'pie' && kind !== 'scatter') spec.stacked = true;
  if (raw.horizontal === true && kind === 'bar') spec.horizontal = true;
  return spec;
}
