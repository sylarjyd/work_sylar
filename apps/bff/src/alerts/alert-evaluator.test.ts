import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertEvaluator,
  type AlertRuleRow,
  type AlertSettingsProvider,
} from './alert-evaluator';
import type { PrismaService } from '../db/prisma.service';
import type { AlertMetricReader } from './alert-metrics';
import type { AlertWebhookNotifier } from './alert-webhook';
import { createBffMetrics } from '../observability/observability.metrics';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const rule: AlertRuleRow = {
  id: 'r-fail',
  key: 'run_failure_rate',
  name: '运行失败率过高',
  metric: 'run_failure_rate',
  comparator: 'gt',
  threshold: 0.2,
  windowMinutes: 15,
  cooldownMinutes: 15,
  severity: 'warning',
  enabled: true,
};

const settings = (enabled = true): AlertSettingsProvider => ({
  getAlertSettings: async () => ({ enabled, webhookUrl: 'https://hooks.example/a', webhookSecret: 's' }),
});

function makeEnv(opts: { open?: unknown; last?: unknown; value?: number | null; enabled?: boolean } = {}) {
  const created: any[] = [];
  const updates: any[] = [];
  const deliveries: any[] = [];
  const prisma = {
    alertEvent: {
      findUnique: async () => opts.open ?? null,
      findFirst: async () => opts.last ?? null,
      create: async ({ data }: any) => {
        const row = { id: 'e1', ...data };
        created.push(row);
        return row;
      },
      update: async (args: any) => {
        updates.push(args);
        return {};
      },
    },
    // 交互式事务：把同一个 mock 客户端传给回调，模拟 tx。
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaService;
  const reader = {
    read: vi.fn(async () => (opts.value === undefined ? 0.31 : opts.value)),
  } as unknown as AlertMetricReader;
  const notifier = {
    send: async (payload: any, target: any) => {
      deliveries.push({ payload, target });
      return { deliveryStatus: 'sent', deliveryError: null, notifiedAt: NOW };
    },
  } as unknown as AlertWebhookNotifier;
  const metrics = createBffMetrics({ defaultMetrics: false });
  const evaluator = new AlertEvaluator(prisma, reader, settings(opts.enabled), notifier, metrics);
  return { evaluator, prisma, reader, deliveries, created, updates, metrics };
}

describe('AlertEvaluator', () => {
  it('首次越界创建 firing 事件并投递，记录投递结果与触发指标', async () => {
    const env = makeEnv();
    await env.evaluator.evaluate(rule, NOW);

    expect(env.created).toHaveLength(1);
    expect(env.created[0]).toMatchObject({
      ruleId: 'r-fail',
      status: 'firing',
      openKey: 'r-fail',
      value: 0.31,
      message: '最近 15 分钟运行失败率为 31%，超过阈值 20%',
    });
    expect(env.deliveries[0].payload).toMatchObject({
      type: 'alert.fired',
      alert: { ruleKey: 'run_failure_rate', severity: 'warning' },
    });
    expect(env.deliveries[0].target).toEqual({
      url: 'https://hooks.example/a',
      secret: 's',
      maxPerHour: 60,
    });
    expect(env.updates.at(-1)?.data).toMatchObject({ deliveryStatus: 'sent', deliveryError: null });
    expect(await env.metrics.registry.metrics()).toContain('ai_office_alerts_fired_total{severity="warning"} 1');
  });

  it('已有未恢复事件时不重复创建也不通知', async () => {
    const env = makeEnv({ open: { id: 'e1', value: 0.31 } });
    await env.evaluator.evaluate(rule, NOW);
    expect(env.created).toHaveLength(0);
    expect(env.deliveries).toHaveLength(0);
  });

  it('恢复正常时关闭事件并发送 resolved', async () => {
    const env = makeEnv({
      open: { id: 'e1', startedAt: new Date('2026-10-20T09:00:00Z') },
      value: 0.1,
    });
    await env.evaluator.evaluate(rule, NOW);

    expect(env.updates[0].data).toMatchObject({
      status: 'resolved',
      resolvedAt: NOW,
      openKey: null,
      value: 0.1,
    });
    expect(env.deliveries[0].payload.type).toBe('alert.resolved');
    expect(env.deliveries[0].payload.alert).toMatchObject({
      id: 'e1',
      startedAt: '2026-10-20T09:00:00.000Z',
    });
  });

  it('冷却期内不创建新事件', async () => {
    const env = makeEnv({ last: { startedAt: new Date(NOW.getTime() - 5 * 60_000) } });
    await env.evaluator.evaluate(rule, NOW);
    expect(env.created).toHaveLength(0);
    expect(env.deliveries).toHaveLength(0);
  });

  it('唯一冲突说明他实例已建，跳过投递', async () => {
    const env = makeEnv();
    (env.prisma.alertEvent as any).create = async () => {
      throw Object.assign(new Error('duplicate'), { code: 'P2002' });
    };
    await env.evaluator.evaluate(rule, NOW);
    expect(env.deliveries).toHaveLength(0);
  });

  it('告警总开关关闭时不读取指标', async () => {
    const env = makeEnv({ enabled: false });
    await env.evaluator.evaluate(rule, NOW);
    expect((env.reader.read as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(env.created).toHaveLength(0);
  });

  it('指标数据不足时保持现状', async () => {
    const env = makeEnv({ open: { id: 'e1' }, value: null });
    await env.evaluator.evaluate(rule, NOW);
    expect(env.updates).toHaveLength(0);
    expect(env.deliveries).toHaveLength(0);
  });
});
