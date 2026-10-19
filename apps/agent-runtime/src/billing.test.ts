import { describe, it, expect } from 'vitest';
import { milliCreditsFor, toUsageEvent } from './billing';

const prices = {
  mock: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
  expensive: { inputMilliCreditsPer1k: 2000, outputMilliCreditsPer1k: 2000 },
};

describe('milliCreditsFor', () => {
  it('按模型分别计价并求和', () => {
    const milli = milliCreditsFor(
      [
        { model: 'mock', input: 1000, output: 1000 },
        { model: 'expensive', input: 1000, output: 0 },
      ],
      prices,
    );
    // mock: 100 + 300 = 400；expensive: 2000；合计 2400 毫积分
    expect(milli).toBe(2400);
  });

  it('未知模型按 0 计，不抛错', () => {
    expect(milliCreditsFor([{ model: 'nope', input: 9999, output: 9999 }], prices)).toBe(0);
  });
});

describe('toUsageEvent', () => {
  it('汇总总量并按模型拆分', () => {
    const map = new Map([
      ['mock', { input: 10, output: 8 }],
      ['other', { input: 5, output: 2 }],
    ]);
    expect(toUsageEvent(map)).toEqual({
      input: 15,
      output: 10,
      models: [
        { model: 'mock', input: 10, output: 8 },
        { model: 'other', input: 5, output: 2 },
      ],
    });
  });
});
