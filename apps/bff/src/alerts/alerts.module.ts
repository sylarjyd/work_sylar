import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AlertEvaluator } from './alert-evaluator';
import { AlertMetricReader } from './alert-metrics';
import { AlertSweeper } from './alert-sweeper';
import { AlertWebhookNotifier } from './alert-webhook';
import { RUNTIME_SUMMARY, RuntimeSummaryClient } from './runtime-summary.client';

/** 告警引擎：指标读取、规则评估、Webhook 投递；管理端复用投递器与载荷构造。 */
@Module({
  imports: [SettingsModule],
  providers: [
    { provide: RUNTIME_SUMMARY, useFactory: () => new RuntimeSummaryClient() },
    AlertMetricReader,
    AlertWebhookNotifier,
    AlertEvaluator,
    AlertSweeper,
  ],
  exports: [AlertMetricReader, AlertWebhookNotifier, AlertEvaluator],
})
export class AlertsModule {}
