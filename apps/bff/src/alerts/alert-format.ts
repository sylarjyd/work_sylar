export interface AlertRuleLike {
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowMinutes: number;
}

const METRIC_LABELS: Record<string, string> = {
  service_up: '服务健康状态',
  run_failure_rate: '运行失败率',
  model_error_rate: '模型错误率',
  run_latency_p95_ms: '运行 P95 耗时',
  billing_settle_failures: '结算滞留数',
  credits_per_window: '积分消耗',
};

const METRIC_FORMATTERS: Record<string, (value: number) => string> = {
  service_up: (value) => (value >= 1 ? '正常' : '异常'),
  run_failure_rate: (value) => `${(value * 100).toFixed(0)}%`,
  model_error_rate: (value) => `${(value * 100).toFixed(0)}%`,
  run_latency_p95_ms: (value) => `${Math.round(value)}ms`,
  billing_settle_failures: (value) => `${Math.round(value)} 条`,
  credits_per_window: (value) => `${Math.round(value)} 积分`,
};

export function formatMetricValue(metric: string, value: number): string {
  return (METRIC_FORMATTERS[metric] ?? ((v: number) => String(v)))(value);
}

export function isBreaching(rule: AlertRuleLike, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return rule.comparator === 'lt'
    ? value < rule.threshold
    : value > rule.threshold;
}

export function formatAlertMessage(rule: AlertRuleLike, value: number): string {
  if (rule.metric === 'service_up') {
    return `最近 ${rule.windowMinutes} 分钟健康检查未全部通过`;
  }
  const label = METRIC_LABELS[rule.metric] ?? rule.metric;
  const direction = rule.comparator === 'lt' ? '低于' : '超过';
  return (
    `最近 ${rule.windowMinutes} 分钟${label}为 ${formatMetricValue(rule.metric, value)}，` +
    `${direction}阈值 ${formatMetricValue(rule.metric, rule.threshold)}`
  );
}

export function formatResolvedMessage(rule: AlertRuleLike, value: number): string {
  if (rule.metric === 'service_up') {
    return `最近 ${rule.windowMinutes} 分钟健康检查已全部通过`;
  }
  const label = METRIC_LABELS[rule.metric] ?? rule.metric;
  return (
    `最近 ${rule.windowMinutes} 分钟${label}已回落至 ${formatMetricValue(rule.metric, value)}，` +
    `阈值 ${formatMetricValue(rule.metric, rule.threshold)}`
  );
}
