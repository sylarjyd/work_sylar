import { describe, expect, it } from 'vitest';
import type { ModelPriceDto } from '@ai-office/shared';
import {
  aggregateRunEnds,
  aggregateRunStarts,
  aggregateToolCalls,
  aggregateUsage,
  allocateModelCredits,
  hourStartOf,
  parseModelUsage,
} from './rollup';

const H = new Date('2026-10-20T08:00:00.000Z');
const price = (input: number, output: number): ModelPriceDto => ({
  inputMilliCreditsPer1k: input,
  outputMilliCreditsPer1k: output,
});

function find(
  buckets: ReturnType<typeof aggregateRunStarts>,
  metric: string,
  dimensionType: string,
  dimensionId = '',
) {
  return buckets.find(
    (b) =>
      b.metric === metric &&
      b.dimensionType === dimensionType &&
      b.dimensionId === dimensionId,
  );
}

describe('指标快照聚合', () => {
  it('按 UTC 整点归档，并同时产出 global 与 tenant 维度', () => {
    expect(hourStartOf(new Date('2026-10-20T08:59:59.999Z')).toISOString()).toBe(
      '2026-10-20T08:00:00.000Z',
    );

    const buckets = aggregateRunStarts(
      [
        { tenantId: 't1', startedAt: new Date('2026-10-20T08:10:00Z') },
        { tenantId: 't1', startedAt: new Date('2026-10-20T08:50:00Z') },
        // 下一小时的数据不属于本桶。
        { tenantId: 't2', startedAt: new Date('2026-10-20T09:00:00Z') },
      ],
      H,
    );

    expect(buckets).toEqual([
      {
        bucketStart: H,
        metric: 'runs_started',
        dimensionType: 'global',
        dimensionId: '',
        value: 2,
        count: 0,
      },
      {
        bucketStart: H,
        metric: 'runs_started',
        dimensionType: 'tenant',
        dimensionId: 't1',
        value: 2,
        count: 0,
      },
    ]);
  });

  it('终态计数与时长只统计 done/failed', () => {
    const buckets = aggregateRunEnds(
      [
        {
          tenantId: 't1',
          status: 'done',
          startedAt: new Date('2026-10-20T08:00:00Z'),
          endedAt: new Date('2026-10-20T08:00:01Z'),
        },
        {
          tenantId: 't1',
          status: 'failed',
          startedAt: new Date('2026-10-20T08:10:00Z'),
          endedAt: new Date('2026-10-20T08:10:02Z'),
        },
        {
          tenantId: 't2',
          status: 'running',
          startedAt: new Date('2026-10-20T08:20:00Z'),
          endedAt: new Date('2026-10-20T08:20:03Z'),
        },
      ],
      H,
    );

    expect(find(buckets, 'runs_done', 'global')).toMatchObject({ value: 1, count: 0 });
    expect(find(buckets, 'runs_failed', 'global')).toMatchObject({ value: 1, count: 0 });
    expect(find(buckets, 'run_duration_ms', 'global')).toMatchObject({ value: 3000, count: 2 });
    expect(find(buckets, 'run_duration_ms', 'tenant', 't1')).toMatchObject({
      value: 3000,
      count: 2,
    });
    expect(find(buckets, 'runs_done', 'tenant', 't2')).toBeUndefined();
  });

  it('token 按 global/model/tenant 聚合，积分按价格比例分摊到模型', () => {
    const buckets = aggregateUsage(
      [
        {
          tenantId: 't1',
          inputTokens: 1500,
          outputTokens: 500,
          credits: 10,
          models: [
            { model: 'a', input: 1000, output: 0 },
            { model: 'b', input: 500, output: 500 },
          ],
        },
      ],
      { a: price(1000, 1000), b: price(1000, 1000) },
      H,
    );

    expect(find(buckets, 'input_tokens', 'global')).toMatchObject({ value: 1500 });
    expect(find(buckets, 'output_tokens', 'global')).toMatchObject({ value: 500 });
    expect(find(buckets, 'input_tokens', 'tenant', 't1')).toMatchObject({ value: 1500 });
    expect(find(buckets, 'credits', 'global')).toMatchObject({ value: 10 });
    expect(find(buckets, 'input_tokens', 'model', 'a')).toMatchObject({ value: 1000 });
    expect(find(buckets, 'output_tokens', 'model', 'b')).toMatchObject({ value: 500 });
    expect(find(buckets, 'credits', 'model', 'a')).toMatchObject({ value: 5 });
    expect(find(buckets, 'credits', 'model', 'b')).toMatchObject({ value: 5 });
  });

  it('缺价格时积分全部落到第一个模型，未结算记录不计积分', () => {
    const models = parseModelUsage([
      { model: 'unknown', input: 10, output: 0 },
      { model: 'known', input: 10, output: 0 },
      { model: '', input: 10, output: 0 },
      { model: 'zero', input: 0, output: 0 },
      'bad',
    ]);
    expect(models).toEqual([
      { model: 'unknown', input: 10, output: 0 },
      { model: 'known', input: 10, output: 0 },
    ]);
    expect(allocateModelCredits(models, {}, 7)).toEqual([{ model: 'unknown', credits: 7 }]);

    const buckets = aggregateUsage(
      [
        {
          tenantId: 't1',
          inputTokens: 1,
          outputTokens: 1,
          credits: null,
          models: [{ model: 'a', input: 1, output: 1 }],
        },
      ],
      {},
      H,
    );
    expect(find(buckets, 'credits', 'global')).toBeUndefined();
    expect(find(buckets, 'credits', 'model', 'a')).toBeUndefined();
  });

  it('工具调用按 tool_result.ok 统计失败，并截断超长工具名', () => {
    const long = 'x'.repeat(80);
    const buckets = aggregateToolCalls(
      [
        { payload: { tool: 'web.search', ok: true } },
        { payload: { tool: 'web.search', ok: false } },
        { payload: { tool: long, ok: true } },
        { payload: null },
        { payload: { ok: true } },
      ],
      H,
    );

    expect(find(buckets, 'tool_calls', 'tool', 'web.search')).toMatchObject({ value: 2 });
    expect(find(buckets, 'tool_failures', 'tool', 'web.search')).toMatchObject({ value: 1 });
    const truncated = buckets.find(
      (b) => b.metric === 'tool_calls' && b.dimensionId.startsWith('x'.repeat(40)),
    );
    expect(truncated?.dimensionId).toHaveLength(64);
    expect(buckets.filter((b) => b.dimensionId === long)).toHaveLength(0);
  });
});
