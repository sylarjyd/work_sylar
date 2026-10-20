import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service';
import { createBffMetrics } from './observability.metrics';

function service(dbOk = true, runtimeOk = true) {
  const prisma = {
    $queryRaw: dbOk ? vi.fn().mockResolvedValue([{ '?column?': 1 }]) : vi.fn().mockRejectedValue(new Error('db down')),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!runtimeOk) throw new Error('runtime down');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return new HealthService(prisma as never, createBffMetrics({ defaultMetrics: false }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REDIS_URL;
});

describe('HealthService', () => {
  it('DB/runtime 正常且 Redis 未配置时 ready，Redis 标记 skipped', async () => {
    const out = await service().ready();
    expect(out.status).toBe('ready');
    expect(out.checks.db).toMatchObject({ ok: true });
    expect(out.checks.redis).toMatchObject({ ok: true, skipped: true });
    expect(out.checks.runtime).toMatchObject({ ok: true });
  });

  it('任一关键依赖失败时 degraded，并置 service_up=0', async () => {
    const svc = service(false, false);
    const out = await svc.ready();
    expect(out.status).toBe('degraded');
    expect(out.checks.db.ok).toBe(false);
    expect(out.checks.runtime.ok).toBe(false);
    const text = await svc.metrics.registry.metrics();
    expect(text).toContain('ai_office_service_up{service="db"} 0');
    expect(text).toContain('ai_office_service_up{service="runtime"} 0');
  });
});
