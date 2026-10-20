import pino, { type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context';
import { currentTrace } from './trace';

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  destination?: DestinationStream;
}

const REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-internal-token',
  'x-agent-runtime-token',
  'password',
  'passwordHash',
  'token',
  'apiKey',
  'secret',
  'webhookUrl',
  'env',
  '*.authorization',
  '*.cookie',
  '*.set-cookie',
  '*.x-internal-token',
  '*.x-agent-runtime-token',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.webhookUrl',
  '*.env',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
];

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const base = {
    service,
    env: process.env.NODE_ENV ?? 'development',
    version: process.env.APP_VERSION ?? '0.0.0',
  };
  const config: pino.LoggerOptions = {
    level,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin() {
      const trace = currentTrace();
      const ctx = currentContext();
      return {
        traceId: trace?.traceId,
        spanId: trace?.spanId,
        requestId: ctx.requestId,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
      };
    },
  };
  const pretty = options.pretty ?? process.env.LOG_PRETTY === '1';
  if (pretty && !options.destination) {
    return pino({
      ...config,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    });
  }
  return pino(config, options.destination);
}
