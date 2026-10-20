export type AlertComparator = 'gt' | 'lt';
export type AlertSeverity = 'warning' | 'critical';

export interface AlertRuleSeed {
  key: string;
  name: string;
  metric: string;
  comparator: AlertComparator;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: AlertSeverity;
  enabled: boolean;
}

/**
 * 内置规则按 key 幂等插入；已存在的规则不覆盖，保留管理员调整。
 * credits_spike 默认关闭：不同业务规模的安全阈值差异过大，需管理员显式设定。
 */
export const BUILTIN_ALERT_RULES: readonly AlertRuleSeed[] = [
  {
    key: 'service_down',
    name: '服务不可用',
    metric: 'service_up',
    comparator: 'lt',
    threshold: 1,
    windowMinutes: 2,
    cooldownMinutes: 5,
    severity: 'critical',
    enabled: true,
  },
  {
    key: 'run_failure_rate',
    name: '运行失败率过高',
    metric: 'run_failure_rate',
    comparator: 'gt',
    threshold: 0.2,
    windowMinutes: 15,
    cooldownMinutes: 15,
    severity: 'warning',
    enabled: true,
  },
  {
    key: 'model_error_rate',
    name: '模型错误率过高',
    metric: 'model_error_rate',
    comparator: 'gt',
    threshold: 0.2,
    windowMinutes: 15,
    cooldownMinutes: 15,
    severity: 'warning',
    enabled: true,
  },
  {
    key: 'run_latency_p95',
    name: '运行 P95 耗时过高',
    metric: 'run_latency_p95_ms',
    comparator: 'gt',
    threshold: 120000,
    windowMinutes: 15,
    cooldownMinutes: 15,
    severity: 'warning',
    enabled: true,
  },
  {
    key: 'billing_settle_failure',
    name: '计费结算滞留',
    metric: 'billing_settle_failures',
    comparator: 'gt',
    threshold: 0,
    windowMinutes: 15,
    cooldownMinutes: 30,
    severity: 'critical',
    enabled: true,
  },
  {
    key: 'credits_spike',
    name: '积分消耗突增',
    metric: 'credits_per_window',
    comparator: 'gt',
    threshold: 100000,
    windowMinutes: 60,
    cooldownMinutes: 60,
    severity: 'warning',
    enabled: false,
  },
];
