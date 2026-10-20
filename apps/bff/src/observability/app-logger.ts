import { Injectable, type LoggerService } from '@nestjs/common';
import { createLogger } from '@ai-office/telemetry';
import type { Logger } from 'pino';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Nest LoggerService → pino；context 作为字段，错误对象统一放 err。 */
@Injectable()
export class AppLogger implements LoggerService {
  readonly raw: Logger;

  constructor() {
    this.raw = createLogger('bff');
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write('info', message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  private write(level: Level, message: unknown, optional: unknown[]): void {
    const last = optional[optional.length - 1];
    const context = typeof last === 'string' ? last : undefined;
    const err =
      message instanceof Error
        ? { type: message.name, message: message.message, stack: message.stack }
        : undefined;
    const msg = message instanceof Error ? message.message : String(message);
    this.raw[level]({ msg, context, err });
  }
}
