import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ModelPriceDto, RunBilling, UsageEvent } from '@ai-office/shared';
import { createBffMetrics } from './observability.metrics';
import { allocateModelCredits, RunTelemetry } from './run-telemetry';

const price = (input: number, output: number): ModelPriceDto => ({
  inputMilliCreditsPer1k: input,
  outputMilliCreditsPer1k: output,
});

const billing: RunBilling = {
  maxCredits: 100,
  allowedModels: ['a', 'b'],
  prices: { a: price(1000, 1000), b: price(1000, 1000) },
};

const usage: UsageEvent = {
  input: 1000,
  output: 1000,
  models: [
    { model: 'a', input: 1000, output: 0 },
    { model: 'b', input: 0, output: 1000 },
  ],
};

describe('RunTelemetry', () => {
  it('按价格比例分摊积分且总和等于计费总额', () => {
    expect(allocateModelCredits(usage.models, billing.prices, 2)).toEqual([
      { model: 'a', credits: 1 },
      { model: 'b', credits: 1 },
    ]);
  });

  it('cap 为 0 时不产生模型积分', () => {
    expect(allocateModelCredits([{ model: 'a', input: 1, output: 1 }], billing.prices, 0)).toEqual([]);
  });

  it('finish 只执行一次并记录运行状态、token 与积分', async () => {
    const metrics = createBffMetrics({ defaultMetrics: false });
    const telemetry = new RunTelemetry(metrics);
    telemetry.finish('done', usage, billing, 1.5);
    telemetry.finish('failed', null, billing, 9);
    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_active_runs 0');
    expect(text).toContain('ai_office_runs_total{status="done"} 1');
    expect(text).not.toContain('status="failed"');
    expect(text).toContain('ai_office_model_tokens_total{model="a",type="input"} 1000');
    expect(text).toContain('ai_office_model_credits_total{model="a"} 1');
  });

  it('forceFail 让早期失败路径仍标记 failed', async () => {
    const metrics = createBffMetrics({ defaultMetrics: false });
    const telemetry = new RunTelemetry(metrics);
    telemetry.forceFail();
    telemetry.finish('done', null, billing, 0);
    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_runs_total{status="failed"} 1');
  });
});
