import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { HealthCheckDto, HealthReadyDto } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { BFF_METRICS, type BffMetrics } from './observability.metrics';

const CHECK_TIMEOUT_MS = 2000;

function appVersion(): string {
  return process.env.APP_VERSION ?? '0.0.0';
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), CHECK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private redis?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BFF_METRICS) readonly metrics: BffMetrics,
  ) {}

  async ready(): Promise<HealthReadyDto> {
    const [db, redis, runtime] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkRuntime(),
    ]);
    this.metrics.serviceUp.set({ service: 'db' }, db.ok ? 1 : 0);
    this.metrics.serviceUp.set({ service: 'redis' }, redis.ok ? 1 : 0);
    this.metrics.serviceUp.set({ service: 'runtime' }, runtime.ok ? 1 : 0);
    const status = db.ok && redis.ok && runtime.ok ? 'ready' : 'degraded';
    return { status, version: appVersion(), checks: { db, redis, runtime } };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      this.redis.disconnect();
      this.redis = undefined;
    }
  }

  private async checkDb(): Promise<HealthCheckDto> {
    const started = Date.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, 'db');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private async checkRedis(): Promise<HealthCheckDto> {
    if (!process.env.REDIS_URL) return { ok: true, skipped: true };
    const started = Date.now();
    try {
      const client = this.redisClient();
      await withTimeout(client.ping(), 'redis');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      this.redis?.disconnect();
      this.redis = undefined;
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private async checkRuntime(): Promise<HealthCheckDto> {
    const started = Date.now();
    const base = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const token = process.env.AGENT_RUNTIME_TOKEN;
    try {
      const res = await withTimeout(
        fetch(`${base.replace(/\/+$/, '')}/health`, {
          headers: token ? { 'x-agent-runtime-token': token } : {},
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        }),
        'runtime',
      );
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private redisClient(): Redis {
    if (!this.redis) {
      this.redis = new Redis(process.env.REDIS_URL as string, {
        lazyConnect: true,
        connectTimeout: CHECK_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        commandTimeout: CHECK_TIMEOUT_MS,
      });
      // 健康检查自己汇报错误；这里吞掉 error 事件，避免 ioredis 未处理事件导致进程退出。
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }
}
