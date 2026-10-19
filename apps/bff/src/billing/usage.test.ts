import { describe, it, expect } from 'vitest';
import { parseUsageEvent, parseModels, aggregateUsage } from './usage';

const prices = { chat: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 } };

describe('parseUsageEvent', () => {
  it('合法结构原样解析', () => {
    expect(
      parseUsageEvent({ input: 3, output: 2, models: [{ model: 'chat', input: 3, output: 2 }] }),
    ).toEqual({ input: 3, output: 2, models: [{ model: 'chat', input: 3, output: 2 }] });
  });
  it('非法结构返回 null', () => {
    expect(parseUsageEvent({ input: 3 })).toBeNull();
    expect(parseUsageEvent(null)).toBeNull();
  });
});

describe('parseModels', () => {
  it('过滤非法项', () => {
    expect(parseModels([{ model: 'a', input: 1, output: 2 }, { model: 1 }, null])).toEqual([
      { model: 'a', input: 1, output: 2 },
    ]);
  });
});

describe('数值校验', () => {
  it('拒绝 NaN / Infinity / 负数 token', () => {
    expect(parseUsageEvent({ input: Number.NaN, output: 1, models: [] })).toBeNull();
    expect(parseUsageEvent({ input: 1, output: Number.POSITIVE_INFINITY, models: [] })).toBeNull();
    expect(parseUsageEvent({ input: -1, output: 1, models: [] })).toBeNull();
    expect(
      parseModels([
        { model: 'a', input: Number.NaN, output: 1 },
        { model: '', input: 1, output: 1 },
      ]),
    ).toEqual([]);
  });
});

describe('aggregateUsage', () => {
  const rows = [
    {
      createdAt: new Date('2026-10-18T10:00:00Z'),
      credits: 2,
      inputTokens: 10,
      outputTokens: 5,
      models: [{ model: 'chat', input: 10, output: 5 }],
    },
    {
      createdAt: new Date('2026-10-18T12:00:00Z'),
      credits: 1,
      inputTokens: 20,
      outputTokens: 10,
      models: [{ model: 'chat', input: 20, output: 10 }],
    },
  ];

  it('按日聚合', () => {
    expect(aggregateUsage(rows, 'day', prices)).toEqual([
      { key: '2026-10-18', credits: 3, inputTokens: 30, outputTokens: 15, runs: 2 },
    ]);
  });

  it('按模型聚合，积分由模型用量单独折算', () => {
    expect(aggregateUsage(rows, 'model', prices)).toEqual([
      { key: 'chat', credits: 1, inputTokens: 30, outputTokens: 15, runs: 2 },
    ]);
  });
});
