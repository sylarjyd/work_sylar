import { AsyncLocalStorage } from 'node:async_hooks';

export interface TelemetryContext {
  requestId?: string;
  userId?: string;
  tenantId?: string;
  runId?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<TelemetryContext>();

export function currentContext(): TelemetryContext {
  return { ...(storage.getStore() ?? {}) };
}

export function runWithContext<T>(patch: TelemetryContext, fn: () => T): T {
  const next = { ...(storage.getStore() ?? {}), ...patch };
  return storage.run(next, fn);
}

/** 在当前上下文内就地补充字段（JwtGuard 鉴权后回填用户信息）。 */
export function updateContext(patch: TelemetryContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
