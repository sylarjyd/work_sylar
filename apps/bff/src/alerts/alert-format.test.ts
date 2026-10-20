import { describe, expect, it } from 'vitest';
import { BUILTIN_ALERT_RULES } from './alert-rules';
import { formatAlertMessage, formatResolvedMessage, isBreaching } from './alert-format';

const failureRule = BUILTIN_ALERT_RULES.find((r) => r.key === 'run_failure_rate') as (typeof BUILTIN_ALERT_RULES)[number];
const serviceRule = BUILTIN_ALERT_RULES.find((r) => r.key === 'service_down') as (typeof BUILTIN_ALERT_RULES)[number];

describe('告警格式化', () => {
  it('内置规则覆盖规格中的默认值', () => {
    expect(BUILTIN_ALERT_RULES.map((r) => r.key)).toEqual([
      'service_down',
      'run_failure_rate',
      'model_error_rate',
      'run_latency_p95',
      'billing_settle_failure',
      'credits_spike',
    ]);
    expect(BUILTIN_ALERT_RULES.find((r) => r.key === 'credits_spike')?.enabled).toBe(false);
    expect(
      BUILTIN_ALERT_RULES.find((r) => r.key === 'run_latency_p95'),
    ).toMatchObject({ threshold: 120000, windowMinutes: 15, severity: 'warning' });
  });

  it('按比较符判断越界，非有限数不算越界', () => {
    expect(isBreaching(failureRule, 0.31)).toBe(true);
    expect(isBreaching(failureRule, 0.2)).toBe(false);
    expect(isBreaching(serviceRule, 0)).toBe(true);
    expect(isBreaching(serviceRule, 1)).toBe(false);
    expect(isBreaching(failureRule, Number.NaN)).toBe(false);
  });

  it('消息带窗口、当前值、阈值与方向', () => {
    expect(formatAlertMessage(failureRule, 0.31)).toBe(
      '最近 15 分钟运行失败率为 31%，超过阈值 20%',
    );
    expect(formatAlertMessage(serviceRule, 0)).toBe('最近 2 分钟健康检查未全部通过');
    expect(formatResolvedMessage(failureRule, 0.1)).toBe(
      '最近 15 分钟运行失败率已回落至 10%，阈值 20%',
    );
    expect(formatResolvedMessage(serviceRule, 1)).toBe('最近 2 分钟健康检查已全部通过');
  });
});
