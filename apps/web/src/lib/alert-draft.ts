import type { AdminAlertRuleDto, AdminAlertRulePatch } from '@ai-office/shared';

export interface AlertRuleDraft {
  threshold: string;
  windowMinutes: string;
  cooldownMinutes: string;
  severity: 'warning' | 'critical';
  enabled: boolean;
}

export function toDraft(rule: AdminAlertRuleDto): AlertRuleDraft {
  return {
    threshold: String(rule.threshold),
    windowMinutes: String(rule.windowMinutes),
    cooldownMinutes: String(rule.cooldownMinutes),
    severity: rule.severity,
    enabled: rule.enabled,
  };
}

export type DraftParseResult =
  | { ok: true; patch: AdminAlertRulePatch }
  | { ok: false; error: string };

/** 前端预校验与服务端保持同一组边界；最终仍以 PATCH 的校验结果为准。 */
export function parseAlertDraft(draft: AlertRuleDraft): DraftParseResult {
  const threshold = Number(draft.threshold);
  if (draft.threshold.trim() === '' || !Number.isFinite(threshold)) {
    return { ok: false, error: '阈值必须是数字' };
  }
  const windowMinutes = Number(draft.windowMinutes);
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
    return { ok: false, error: '统计窗口必须是 1–1440 的整数分钟' };
  }
  const cooldownMinutes = Number(draft.cooldownMinutes);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1440) {
    return { ok: false, error: '冷却时间必须是 0–1440 的整数分钟' };
  }
  return {
    ok: true,
    patch: {
      threshold,
      windowMinutes,
      cooldownMinutes,
      severity: draft.severity,
      enabled: draft.enabled,
    },
  };
}

export function alertDeliveryText(
  status: 'sent' | 'failed' | 'skipped' | null,
  error: string | null,
): string {
  if (status === null) return '未投递';
  if (status === 'sent') return '已投递';
  if (status === 'failed') {
    return error?.startsWith('http_') ? `投递失败（HTTP ${error.slice(5)}）` : '投递失败';
  }
  const map: Record<string, string> = {
    webhook_not_configured: '未配置 Webhook',
    webhook_url_empty: '未配置 Webhook',
    invalid_url: 'Webhook 地址无效',
    rate_limited: '超出每小时配额',
    rule_disabled: '规则已停用',
  };
  return map[error ?? ''] ?? '已跳过';
}
