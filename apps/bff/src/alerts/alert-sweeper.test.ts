import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertSweeper } from './alert-sweeper';
import { BUILTIN_ALERT_RULES } from './alert-rules';
import type { PrismaService } from '../db/prisma.service';
import type { LeaderLock } from '../metrics/leader-lock';
import type { AlertEvaluator } from './alert-evaluator';
import { createBffMetrics } from '../observability/observability.metrics';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const lock = (acquired = true): LeaderLock => ({ acquire: async () => acquired });

function makeSweeper(rules: any[], acquired = true) {
  const evaluated: string[] = [];
  const seeds: any[] = [];
  const prisma = {
    alertRule: {
      createMany: async (args: any) => {
        seeds.push(args);
        return { count: 0 };
      },
      findMany: async () => rules,
    },
  } as unknown as PrismaService;
  const evaluator = {
    evaluate: async (rule: any) => {
      evaluated.push(rule.key);
      if (rule.key === 'bad') throw new Error('evaluate failed');
    },
  } as unknown as AlertEvaluator;
  const metrics = createBffMetrics({ defaultMetrics: false });
  return {
    sweeper: new AlertSweeper(prisma, lock(acquired), evaluator, metrics),
    evaluated,
    seeds,
    metrics,
  };
}

afterEach(() => {
  delete process.env.ALERT_EVAL_MS;
});

describe('AlertSweeper', () => {
  it('幂等写入内置规则且不改动已有规则', async () => {
    const { sweeper, seeds } = makeSweeper([]);
    await sweeper.seed();
    expect(seeds).toHaveLength(1);
    expect(seeds[0].skipDuplicates).toBe(true);
    expect(seeds[0].data.map((r: any) => r.key)).toEqual(
      BUILTIN_ALERT_RULES.map((r) => r.key),
    );
  });

  it('未抢到锁时跳过评估', async () => {
    const { sweeper, evaluated } = makeSweeper([], false);
    await sweeper.tick(NOW);
    expect(evaluated).toHaveLength(0);
  });

  it('逐条评估启用规则，单条失败不影响后续并计入失败指标', async () => {
    const { sweeper, evaluated, metrics } = makeSweeper([
      { key: 'bad' },
      { key: 'run_failure_rate' },
    ]);
    await sweeper.tick(NOW);
    expect(evaluated).toEqual(['bad', 'run_failure_rate']);
    expect(await metrics.registry.metrics()).toContain(
      'ai_office_alert_eval_failures_total 1',
    );
  });

  it('首次 tick 前先补齐规则', async () => {
    const { sweeper, seeds } = makeSweeper([]);
    await sweeper.tick(NOW);
    expect(seeds).toHaveLength(1);
  });

  it('tick 内并发保护：上一轮未结束时直接返回', async () => {
    const { sweeper, evaluated } = makeSweeper([{ key: 'run_failure_rate' }]);
    await Promise.all([sweeper.tick(NOW), sweeper.tick(NOW)]);
    expect(evaluated).toHaveLength(1);
  });
});
