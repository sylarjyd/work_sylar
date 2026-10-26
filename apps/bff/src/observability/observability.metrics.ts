import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import {
  createMetricsRegistry,
  HTTP_DURATION_BUCKETS,
  MODEL_DURATION_BUCKETS,
  RUN_QUEUE_WAIT_BUCKETS,
} from '@ai-office/telemetry';

export const BFF_METRICS = Symbol('BFF_METRICS');

export interface BffMetrics {
  registry: Registry;
  httpRequests: Counter;
  httpDuration: Histogram;
  runsTotal: Counter;
  runDuration: Histogram;
  activeRuns: Gauge;
  modelTokens: Counter;
  modelCredits: Counter;
  billingSettleFailures: Counter;
  runsEnqueued: Counter;
  runsResumed: Counter;
  runsRetried: Counter;
  runsCanceled: Counter;
  runsQueueFailures: Counter;
  runQueueDepth: Gauge;
  runQueueActive: Gauge;
  runQueueWait: Histogram;
  rateLimitHits: Counter;
  alertsFired: Counter;
  alertEvalFailures: Counter;
  rollupFailures: Counter;
  serviceUp: Gauge;
}

export function createBffMetrics(
  options: { defaultMetrics?: boolean } = {},
): BffMetrics {
  const registry = createMetricsRegistry(options);
  return {
    registry,
    httpRequests: new Counter({
      name: 'ai_office_http_requests_total',
      help: 'BFF HTTP 请求数',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'ai_office_http_request_duration_seconds',
      help: 'BFF HTTP 请求耗时',
      labelNames: ['method', 'route'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [registry],
    }),
    runsTotal: new Counter({
      name: 'ai_office_runs_total',
      help: '运行终态数量',
      labelNames: ['status'],
      registers: [registry],
    }),
    runDuration: new Histogram({
      name: 'ai_office_run_duration_seconds',
      help: '运行总耗时',
      buckets: MODEL_DURATION_BUCKETS,
      registers: [registry],
    }),
    activeRuns: new Gauge({
      name: 'ai_office_active_runs',
      help: '进行中的运行数',
      registers: [registry],
    }),
    modelTokens: new Counter({
      name: 'ai_office_model_tokens_total',
      help: '模型 token 用量',
      labelNames: ['model', 'type'],
      registers: [registry],
    }),
    modelCredits: new Counter({
      name: 'ai_office_model_credits_total',
      help: '按模型分摊的积分',
      labelNames: ['model'],
      registers: [registry],
    }),
    billingSettleFailures: new Counter({
      name: 'ai_office_billing_settle_failures_total',
      help: '结算失败次数',
      registers: [registry],
    }),
    runsEnqueued: new Counter({
      name: 'ai_office_runs_enqueued_total',
      help: '成功入队的运行数',
      registers: [registry],
    }),
    runsResumed: new Counter({
      name: 'ai_office_runs_resumed_total',
      help: '断点续跑次数',
      registers: [registry],
    }),
    runsRetried: new Counter({
      name: 'ai_office_runs_retried_total',
      help: '手动重试次数',
      registers: [registry],
    }),
    runsCanceled: new Counter({
      name: 'ai_office_runs_canceled_total',
      help: '被取消的运行数',
      registers: [registry],
    }),
    runsQueueFailures: new Counter({
      name: 'ai_office_runs_queue_failures_total',
      help: '队列作业失败次数',
      registers: [registry],
    }),
    runQueueDepth: new Gauge({
      name: 'ai_office_run_queue_depth',
      help: '待执行的队列作业数',
      registers: [registry],
    }),
    runQueueActive: new Gauge({
      name: 'ai_office_run_queue_active',
      help: '正在执行的队列作业数',
      registers: [registry],
    }),
    runQueueWait: new Histogram({
      name: 'ai_office_run_queue_wait_seconds',
      help: '运行从入队到开始执行的等待时长',
      buckets: RUN_QUEUE_WAIT_BUCKETS,
      registers: [registry],
    }),
    rateLimitHits: new Counter({
      name: 'ai_office_rate_limit_hits_total',
      help: '限流命中次数',
      labelNames: ['scope'],
      registers: [registry],
    }),
    alertsFired: new Counter({
      name: 'ai_office_alerts_fired_total',
      help: '告警触发次数',
      labelNames: ['severity'],
      registers: [registry],
    }),
    alertEvalFailures: new Counter({
      name: 'ai_office_alert_eval_failures_total',
      help: '告警评估失败次数',
      registers: [registry],
    }),
    rollupFailures: new Counter({
      name: 'ai_office_rollup_failures_total',
      help: '快照失败次数',
      registers: [registry],
    }),
    serviceUp: new Gauge({
      name: 'ai_office_service_up',
      help: '依赖服务健康状态',
      labelNames: ['service'],
      registers: [registry],
    }),
  };
}
