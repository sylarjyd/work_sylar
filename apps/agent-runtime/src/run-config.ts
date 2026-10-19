import type { RunConfig } from '@ai-office/shared';

export interface ResolvedRunConfig {
  maxRounds: number;
  confirmTimeoutMs: number;
  codeExecTimeoutMs: number;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max
    ? raw
    : fallback;
}

/** runtime 不信任 BFF 下传值：越界、非整数、负数一律回落到 env 或默认值。 */
export function resolveRunConfig(
  config: RunConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedRunConfig {
  return {
    maxRounds: clampInt(config?.maxRounds, 1, 32, clampInt(Number(env.MAX_ROUNDS), 1, 32, 8)),
    confirmTimeoutMs: clampInt(
      config?.confirmTimeoutMs,
      1000,
      600000,
      clampInt(Number(env.CONFIRM_TIMEOUT_MS), 1000, 600000, 120000),
    ),
    codeExecTimeoutMs: clampInt(
      config?.codeExecTimeoutMs,
      100,
      60000,
      clampInt(Number(env.CODE_EXEC_TIMEOUT_MS), 100, 60000, 5000),
    ),
  };
}
