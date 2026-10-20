import { afterAll, describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import {
  createLogger,
  initTelemetry,
  runWithContext,
  shutdownTelemetry,
  withSpan,
} from './index';

// pino mixin 依赖全局 tracer provider；vitest 每个测试文件独立进程，这里需自行初始化。
initTelemetry({ serviceName: 'telemetry-logger-test', serviceVersion: '1.0.0' });

afterAll(async () => {
  await shutdownTelemetry();
});


function capture() {
  const lines: string[] = [];
  const destination: DestinationStream = {
    write(line: string) {
      lines.push(line);
    },
  };
  return { lines, destination };
}

describe('createLogger', () => {
  it('自动附加请求/trace 字段并脱敏', async () => {
    const { lines, destination } = capture();
    const logger = createLogger('svc', { destination, pretty: false, level: 'info' });
    await withSpan('root', {}, async () =>
      runWithContext({ requestId: 'rid', userId: 'u1', tenantId: 't1' }, () => {
        logger.info(
          {
            authorization: 'Bearer secret',
            nested: { apiKey: 'k-1', password: 'p' },
            message: 'hello',
          },
          'hello',
        );
      }),
    );
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.service).toBe('svc');
    expect(row.requestId).toBe('rid');
    expect(row.userId).toBe('u1');
    expect(row.tenantId).toBe('t1');
    expect(row.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(row.authorization).toBe('[redacted]');
    expect((row.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((row.nested as Record<string, unknown>).password).toBe('[redacted]');
  });

  it('无上下文时不写 undefined 字段', () => {
    const { lines, destination } = capture();
    const logger = createLogger('svc', { destination, pretty: false, level: 'info' });
    logger.info('plain');
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.msg).toBe('plain');
    expect(row.traceId).toBeUndefined();
    expect(row.requestId).toBeUndefined();
  });
});
