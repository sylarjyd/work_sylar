import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import pino from 'pino';
import { initTelemetry, shutdownTelemetry } from '@ai-office/telemetry';
import { createBffMetrics } from './observability.metrics';
import { registerRequestTelemetry, sanitizeRequestId } from './request-telemetry';
import { observabilityAllowed } from './observability-access';

beforeAll(() => {
  initTelemetry({ serviceName: 'bff-test', serviceVersion: '1' });
});

afterAll(async () => {
  await shutdownTelemetry();
});

describe('request telemetry', () => {
  it('透传合法 request id，写响应头并记录 HTTP 指标', async () => {
    const app = Fastify();
    const metrics = createBffMetrics({ defaultMetrics: false });
    registerRequestTelemetry(app, metrics, pino({ level: 'silent' }));
    app.get('/x/:id', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/x/1?token=secret',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');

    const text = await metrics.registry.metrics();
    expect(text).toContain('ai_office_http_requests_total');
    expect(text).toContain('route="/x/:id"');
    expect(text).toContain('status="200"');
    await app.close();
  });

  it('非法 request id 重新生成，健康/指标路径不计数', async () => {
    const app = Fastify();
    const metrics = createBffMetrics({ defaultMetrics: false });
    registerRequestTelemetry(app, metrics, pino({ level: 'silent' }));
    app.get('/api/health', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'bad id\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const text = await metrics.registry.metrics();
    expect(text).not.toContain('route="/api/health"');
    await app.close();
  });

  it('request id 白名单', () => {
    expect(sanitizeRequestId('abc-DEF_1')).toBeNull();
    expect(sanitizeRequestId('abc-DEF-1')).toBe('abc-DEF-1');
    expect(sanitizeRequestId('x'.repeat(65))).toBeNull();
  });

  it('只有回环或内部 token 可访问', () => {
    const saved = process.env.INTERNAL_TOKEN;
    process.env.INTERNAL_TOKEN = 'secret';
    try {
      expect(
        observabilityAllowed({ ip: '127.0.0.1', headers: {} } as never),
      ).toBe(true);
      expect(
        observabilityAllowed({ ip: '10.0.0.1', headers: {} } as never),
      ).toBe(false);
      expect(
        observabilityAllowed({
          ip: '10.0.0.1',
          headers: { 'x-internal-token': 'secret' },
        } as never),
      ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_TOKEN;
      else process.env.INTERNAL_TOKEN = saved;
    }
  });
});
