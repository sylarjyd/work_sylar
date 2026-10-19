import { describe, it, expect } from 'vitest';
import { computeCredits } from './credits';

const prices = {
  chat: { inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
};

describe('computeCredits', () => {
  it('4000 token 约 1 积分', () => {
    expect(computeCredits([{ model: 'chat', input: 4000, output: 0 }], prices, 100)).toBe(1);
  });

  it('结果向上取整', () => {
    // 输入 1000 + 输出 1000 = 400 毫积分 → 0.4 → 1
    expect(computeCredits([{ model: 'chat', input: 1000, output: 1000 }], prices, 100)).toBe(1);
    // 输入 10000 + 输出 10000 = 4000 毫积分 → 4
    expect(computeCredits([{ model: 'chat', input: 10000, output: 10000 }], prices, 100)).toBe(4);
  });

  it('最低 1 积分', () => {
    expect(computeCredits([{ model: 'chat', input: 1, output: 0 }], prices, 100)).toBe(1);
  });

  it('封顶在 cap', () => {
    expect(computeCredits([{ model: 'chat', input: 1_000_000, output: 0 }], prices, 7)).toBe(7);
  });

  it('未知模型不计价但仍有最低 1 积分', () => {
    expect(computeCredits([{ model: 'nope', input: 9999, output: 9999 }], prices, 100)).toBe(1);
  });
});
