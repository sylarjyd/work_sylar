import { describe, expect, it } from 'vitest';
import type { AdminAlertRuleDto } from '@ai-office/shared';
import { alertDeliveryText, parseAlertDraft, toDraft } from './alert-draft';

const rule: AdminAlertRuleDto = {
  id: 'r1',
  key: 'run_failure_rate',
  name: '运行失败率',
  metric: 'run_failure_rate',
  comparator: 'gt',
  threshold: 0.2,
  windowMinutes: 15,
  cooldownMinutes: 60,
  severity: 'warning',
  enabled: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('alert-draft', () => {
  it('toDraft 把数值转成输入框文本', () => {
    expect(toDraft(rule)).toEqual({
      threshold: '0.2',
      windowMinutes: '15',
      cooldownMinutes: '60',
      severity: 'warning',
      enabled: true,
    });
  });

  it('parseAlertDraft 接受合法输入并保留 0 值', () => {
    const parsed = parseAlertDraft({
      threshold: '0',
      windowMinutes: '1',
      cooldownMinutes: '0',
      severity: 'critical',
      enabled: false,
    });
    expect(parsed).toEqual({
      ok: true,
      patch: {
        threshold: 0,
        windowMinutes: 1,
        cooldownMinutes: 0,
        severity: 'critical',
        enabled: false,
      },
    });
  });

  it('parseAlertDraft 拦截非数字阈值与越界窗口', () => {
    expect(parseAlertDraft({ ...toDraft(rule), threshold: '' })).toEqual({
      ok: false,
      error: '阈值必须是数字',
    });
    expect(parseAlertDraft({ ...toDraft(rule), threshold: 'abc' })).toEqual({
      ok: false,
      error: '阈值必须是数字',
    });
    expect(parseAlertDraft({ ...toDraft(rule), windowMinutes: '1.5' })).toEqual({
      ok: false,
      error: '统计窗口必须是 1–1440 的整数分钟',
    });
    expect(parseAlertDraft({ ...toDraft(rule), windowMinutes: '0' })).toEqual({
      ok: false,
      error: '统计窗口必须是 1–1440 的整数分钟',
    });
    expect(parseAlertDraft({ ...toDraft(rule), cooldownMinutes: '-1' })).toEqual({
      ok: false,
      error: '冷却时间必须是 0–1440 的整数分钟',
    });
  });

  it('alertDeliveryText 把内部投递码翻成运营能看懂的状态', () => {
    expect(alertDeliveryText(null, null)).toBe('未投递');
    expect(alertDeliveryText('sent', null)).toBe('已投递');
    expect(alertDeliveryText('skipped', 'webhook_not_configured')).toBe('未配置 Webhook');
    expect(alertDeliveryText('skipped', 'rate_limited')).toBe('超出每小时配额');
    expect(alertDeliveryText('skipped', 'rule_disabled')).toBe('规则已停用');
    expect(alertDeliveryText('skipped', 'something_else')).toBe('已跳过');
    expect(alertDeliveryText('failed', 'http_500')).toBe('投递失败（HTTP 500）');
    expect(alertDeliveryText('failed', 'timeout')).toBe('投递失败');
  });
});
