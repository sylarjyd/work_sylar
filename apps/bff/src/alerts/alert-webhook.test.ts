import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_TEST_PAYLOAD_ID,
  buildAlertPayload,
  AlertWebhookNotifier,
  alertDashboardUrl,
} from './alert-webhook';
import { BUILTIN_ALERT_RULES } from './alert-rules';

const rule = BUILTIN_ALERT_RULES.find((r) => r.key === 'run_failure_rate')!;
const event = {
  id: 'e1',
  value: 0.31,
  message: '最近 15 分钟运行失败率为 31%，超过阈值 20%',
  startedAt: new Date('2026-10-20T06:00:00.000Z'),
};
const payload = buildAlertPayload('alert.fired', rule, event, 'https://web.example/admin/alerts');
const target = { url: 'https://hooks.example/alert', secret: 'topsecret', maxPerHour: 60 };
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

describe('AlertWebhookNotifier', () => {
  it('签名并投递，redirect 不跟随', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    const result = await notifier.send(payload, target);
    expect(result).toEqual({
      deliveryStatus: 'sent',
      deliveryError: null,
      notifiedAt: new Date(NOW),
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-ai-office-signature']).toBe(
      `sha256=${createHmac('sha256', 'topsecret').update(init.body as string).digest('hex')}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      version: 1,
      type: 'alert.fired',
      alert: { id: 'e1', ruleKey: 'run_failure_rate', threshold: 0.2 },
    });
  });

  it('未配置 URL 或非 http(s) 时跳过，不发请求', async () => {
    const fetchImpl = vi.fn();
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(notifier.send(payload, { ...target, url: '' })).resolves.toMatchObject({
      deliveryStatus: 'skipped',
      deliveryError: 'webhook_url_empty',
      notifiedAt: null,
    });
    await expect(notifier.send(payload, { ...target, url: 'file:///etc/passwd' })).resolves.toMatchObject({
      deliveryStatus: 'skipped',
      deliveryError: 'invalid_url',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('5xx 重试两次后退避 1s/5s，最终失败', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const sleep = vi.fn(async () => undefined);
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => NOW,
    });

    const result = await notifier.send(payload, target);
    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toBe('http_500');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 5000]);
  });

  it('4xx 不重试；网络异常重试后成功', async () => {
    const bad = vi.fn(async () => new Response('bad', { status: 400 }));
    const noRetry = new AlertWebhookNotifier({
      fetchImpl: bad as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => NOW,
    });
    expect((await noRetry.send(payload, target)).deliveryError).toBe('http_400');
    expect(bad).toHaveBeenCalledTimes(1);

    let calls = 0;
    const flaky = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('econnrefused');
      return new Response('ok', { status: 200 });
    });
    const notifier = new AlertWebhookNotifier({
      fetchImpl: flaky as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => NOW,
    });
    await expect(notifier.send(payload, target)).resolves.toMatchObject({
      deliveryStatus: 'sent',
    });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('每小时配额用尽后只跳过不发送', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const notifier = new AlertWebhookNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await notifier.send(payload, { ...target, maxPerHour: 1 });
    await expect(notifier.send(payload, { ...target, maxPerHour: 1 })).resolves.toMatchObject({
      deliveryStatus: 'skipped',
      deliveryError: 'rate_limited',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('测试告警使用固定 id 且 dashboardUrl 可推导', () => {
    expect(ALERT_TEST_PAYLOAD_ID).toBe('test');
    expect(alertDashboardUrl({ ADMIN_WEB_URL: 'https://office.example/' })).toBe(
      'https://office.example/admin/alerts',
    );
    expect(alertDashboardUrl({})).toBe('http://localhost:3000/admin/alerts');
  });
});
