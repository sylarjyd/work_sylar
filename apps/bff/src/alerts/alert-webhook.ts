import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';

export type AlertWebhookType = 'alert.fired' | 'alert.resolved' | 'alert.test';

export interface AlertWebhookPayload {
  version: 1;
  type: AlertWebhookType;
  alert: {
    id: string;
    ruleKey: string;
    ruleName: string;
    severity: 'warning' | 'critical';
    value: number;
    threshold: number;
    message: string;
    startedAt: string;
  };
  dashboardUrl: string;
}

export interface AlertDelivery {
  deliveryStatus: 'sent' | 'failed' | 'skipped';
  deliveryError: string | null;
  notifiedAt: Date | null;
}

export interface WebhookTarget {
  url: string;
  secret: string;
  maxPerHour: number;
}

export interface AlertRulePayloadSource {
  key: string;
  name: string;
  severity: string;
  threshold: number;
}

export interface AlertEventPayloadSource {
  id: string;
  value: number;
  message: string;
  startedAt: Date;
}

export const ALERT_TEST_PAYLOAD_ID = 'test';

const RETRY_DELAYS_MS = [1000, 5000];
const REQUEST_TIMEOUT_MS = 5000;
const RATE_WINDOW_MS = 3_600_000;
const MAX_ERROR_LENGTH = 200;
const DEFAULT_MAX_PER_HOUR = 60;

/** 滚动一小时发送配额；非法配置回退默认值，避免 0 值静默关闭全部告警。 */
export function alertMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ALERT_MAX_PER_HOUR ?? DEFAULT_MAX_PER_HOUR);
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(10_000, raw) : DEFAULT_MAX_PER_HOUR;
}

export function alertTarget(config: {
  webhookUrl: string;
  webhookSecret: string;
}): WebhookTarget {
  return { url: config.webhookUrl, secret: config.webhookSecret, maxPerHour: alertMaxPerHour() };
}

export function alertDashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  // 运营端是独立应用，路由没有 /admin 前缀；空字符串视为未配置，回退默认地址。
  const configured = env.ADMIN_WEB_URL?.trim();
  const base = (configured || 'http://localhost:3001').replace(/\/+$/, '');
  return `${base}/alerts`;
}

export function buildAlertPayload(
  type: AlertWebhookType,
  rule: AlertRulePayloadSource,
  event: AlertEventPayloadSource,
  dashboardUrl: string,
): AlertWebhookPayload {
  return {
    version: 1,
    type,
    alert: {
      id: event.id,
      ruleKey: rule.key,
      ruleName: rule.name,
      severity: rule.severity === 'critical' ? 'critical' : 'warning',
      value: event.value,
      threshold: rule.threshold,
      message: event.message,
      startedAt: event.startedAt.toISOString(),
    },
    dashboardUrl,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function signAlertPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

type WarnLogger = Pick<Logger, 'warn'>;

/**
 * Webhook 投递：5 秒超时、不跟随重定向、仅 http(s)、HMAC 签名、最多 3 次。
 * 4xx（429 除外）重试无意义，直接失败；4xx/5xx/网络错误都在这里收敛为投递结果，
 * 不让告警评估因外部端点故障而中断。
 */
export class AlertWebhookNotifier {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: WarnLogger;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  private readonly sentAt: number[] = [];

  constructor(
    options: {
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      logger?: WarnLogger;
      retryDelaysMs?: number[];
      timeoutMs?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? new Logger(AlertWebhookNotifier.name);
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async send(payload: AlertWebhookPayload, target: WebhookTarget): Promise<AlertDelivery> {
    if (!target.url) return this.skipped('webhook_url_empty');
    if (!isHttpUrl(target.url)) return this.skipped('invalid_url');
    if (!this.takeQuota(target.maxPerHour)) {
      this.logger.warn('[alerts] Webhook 每小时配额已用尽，本条仅记录事件');
      return this.skipped('rate_limited');
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (target.secret) headers['x-ai-office-signature'] = signAlertPayload(body, target.secret);

    let error = 'unknown_error';
    // 初次请求 + 2 次重试，共 3 次；两次重试前分别等待 1s、5s。
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        const res = await this.fetchImpl(target.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          return { deliveryStatus: 'sent', deliveryError: null, notifiedAt: new Date(this.now()) };
        }
        error = `http_${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        error = (err as Error).message || 'fetch_failed';
      }
      // 最后一次尝试后不再退避等待。
      if (attempt < this.retryDelaysMs.length) {
        await this.sleep(this.retryDelaysMs[attempt] as number);
      }
    }

    const deliveryError = error.slice(0, MAX_ERROR_LENGTH);
    this.logger.warn(`[alerts] Webhook 投递失败: ${deliveryError}`);
    return { deliveryStatus: 'failed', deliveryError, notifiedAt: new Date(this.now()) };
  }

  /** 滚动 1 小时配额；重试消耗的是同一条通知，不重复计数。 */
  private takeQuota(maxPerHour: number): boolean {
    const now = this.now();
    while (this.sentAt.length > 0 && now - (this.sentAt[0] as number) >= RATE_WINDOW_MS) {
      this.sentAt.shift();
    }
    if (this.sentAt.length >= maxPerHour) return false;
    this.sentAt.push(now);
    return true;
  }

  private skipped(error: string): AlertDelivery {
    return { deliveryStatus: 'skipped', deliveryError: error, notifiedAt: null };
  }
}
