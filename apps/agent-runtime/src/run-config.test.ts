import { describe, it, expect } from 'vitest';
import { resolveRunConfig } from './run-config';

describe('resolveRunConfig', () => {
  it('请求值优先于 env', () => {
    const out = resolveRunConfig(
      { maxRounds: 3, confirmTimeoutMs: 2000, codeExecTimeoutMs: 500 },
      { MAX_ROUNDS: '10', CONFIRM_TIMEOUT_MS: '9000', CODE_EXEC_TIMEOUT_MS: '3000' },
    );
    expect(out).toEqual({ maxRounds: 3, confirmTimeoutMs: 2000, codeExecTimeoutMs: 500 });
  });

  it('越界/非整数请求值回落到 env', () => {
    const out = resolveRunConfig(
      { maxRounds: 99, confirmTimeoutMs: 1.5, codeExecTimeoutMs: 'x' as never },
      { MAX_ROUNDS: '10', CONFIRM_TIMEOUT_MS: '9000', CODE_EXEC_TIMEOUT_MS: '3000' },
    );
    expect(out).toEqual({ maxRounds: 10, confirmTimeoutMs: 9000, codeExecTimeoutMs: 3000 });
  });

  it('env 也非法时回落到默认值', () => {
    const out = resolveRunConfig(undefined, {});
    expect(out).toEqual({ maxRounds: 8, confirmTimeoutMs: 120000, codeExecTimeoutMs: 5000 });
  });

  it('请求值为 0 或负数视为非法', () => {
    const out = resolveRunConfig({ maxRounds: 0, confirmTimeoutMs: -1, codeExecTimeoutMs: 0 }, {});
    expect(out).toEqual({ maxRounds: 8, confirmTimeoutMs: 120000, codeExecTimeoutMs: 5000 });
  });
});
