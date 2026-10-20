import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../db/prisma.service';
import { BFF_METRICS, type BffMetrics } from '../observability/observability.metrics';
import { AlertMetricReader } from './alert-metrics';
import { isBreaching, formatAlertMessage, formatResolvedMessage } from './alert-format';
import {
  AlertWebhookNotifier,
  alertDashboardUrl,
  alertTarget,
  buildAlertPayload,
  type AlertDelivery,
} from './alert-webhook';

export interface AlertRuleRow {
  id: string;
  key: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: string;
  enabled: boolean;
}

export interface AlertSettingsProvider {
  getAlertSettings(): Promise<{
    enabled: boolean;
    webhookUrl: string;
    webhookSecret: string;
  }>;
}

interface OpenEvent {
  id: string;
  startedAt: Date;
}

interface CreatedEvent {
  id: string;
  startedAt: Date;
  value: number;
  message: string;
}

/**
 * 单条规则的状态机：
 * 越界且无 open 事件 → 创建 firing（唯一键冲突说明他实例已建）→ 通知；
 * 持续越界 → 保持首次值不变、不重复通知；
 * 恢复 → 关闭 open 事件并通知 resolved。
 */
@Injectable()
export class AlertEvaluator {
  private readonly logger = new Logger(AlertEvaluator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AlertMetricReader,
    @Inject(SettingsService) private readonly settings: AlertSettingsProvider,
    private readonly notifier: AlertWebhookNotifier,
    @Optional() @Inject(BFF_METRICS) private readonly metrics?: BffMetrics,
  ) {}

  async evaluate(rule: AlertRuleRow, now = new Date()): Promise<void> {
    const config = await this.settings.getAlertSettings();
    if (!config.enabled) return;

    const value = await this.reader.read(rule.metric, rule.windowMinutes, now);
    if (value === null || !Number.isFinite(value)) return;

    const open = (await this.prisma.alertEvent.findUnique({
      where: { openKey: rule.id },
    })) as OpenEvent | null;

    if (isBreaching(rule, value)) {
      if (open) return;
      const last = await this.prisma.alertEvent.findFirst({
        where: { ruleId: rule.id },
        orderBy: { startedAt: 'desc' },
      });
      if (
        last &&
        now.getTime() - last.startedAt.getTime() < rule.cooldownMinutes * 60_000
      ) {
        this.logger.warn(`[alerts] 规则 ${rule.key} 仍在冷却期，跳过通知`);
        return;
      }
      await this.fire(rule, value, now, config);
      return;
    }

    if (open) await this.resolve(rule, open, value, now, config);
  }

  private async fire(
    rule: AlertRuleRow,
    value: number,
    now: Date,
    config: Awaited<ReturnType<AlertSettingsProvider['getAlertSettings']>>,
  ): Promise<void> {
    const message = formatAlertMessage(rule, value);
    let event: CreatedEvent;
    try {
      event = await this.prisma.$transaction(async (tx) =>
        tx.alertEvent.create({
          data: {
            ruleId: rule.id,
            ruleName: rule.name,
            status: 'firing',
            value,
            message,
            startedAt: now,
            // openKey 唯一：数据库层保证每条规则最多一个未恢复事件。
            openKey: rule.id,
          },
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return;
      throw err;
    }

    this.metrics?.alertsFired.inc({ severity: rule.severity });
    const delivery = await this.notifier.send(
      buildAlertPayload('alert.fired', rule, event, alertDashboardUrl()),
      alertTarget(config),
    );
    await this.applyDelivery(event.id, delivery);
  }

  private async resolve(
    rule: AlertRuleRow,
    open: OpenEvent,
    value: number,
    now: Date,
    config: Awaited<ReturnType<AlertSettingsProvider['getAlertSettings']>>,
  ): Promise<void> {
    const message = formatResolvedMessage(rule, value);
    await this.prisma.alertEvent.update({
      where: { id: open.id },
      data: {
        status: 'resolved',
        resolvedAt: now,
        value,
        message,
        // 置空后才能允许下一次触发；PostgreSQL 唯一索引允许多个 NULL。
        openKey: null,
      },
    });

    const delivery = await this.notifier.send(
      buildAlertPayload(
        'alert.resolved',
        rule,
        { id: open.id, value, message, startedAt: open.startedAt },
        alertDashboardUrl(),
      ),
      alertTarget(config),
    );
    await this.applyDelivery(open.id, delivery);
  }

  private async applyDelivery(id: string, delivery: AlertDelivery): Promise<void> {
    await this.prisma.alertEvent.update({
      where: { id },
      data: {
        deliveryStatus: delivery.deliveryStatus,
        deliveryError: delivery.deliveryError,
        notifiedAt: delivery.notifiedAt,
      },
    });
  }

}
