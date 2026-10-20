import type { RuntimeSummaryDto } from '@ai-office/shared';

export const RUNTIME_SUMMARY = Symbol('RUNTIME_SUMMARY');

export interface RuntimeSummaryProvider {
  fetch(windowMinutes: number): Promise<RuntimeSummaryDto | null>;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** runtime `/metrics/summary` 客户端；失败返回 null，由调用方视为数据不足。 */
export class RuntimeSummaryClient implements RuntimeSummaryProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    options: {
      baseUrl?: string;
      token?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
    this.token = options.token ?? process.env.AGENT_RUNTIME_TOKEN ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetch(windowMinutes: number): Promise<RuntimeSummaryDto | null> {
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/metrics/summary?windowMinutes=${windowMinutes}`,
        {
          headers: this.token ? { 'x-agent-runtime-token': this.token } : {},
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok) return null;
      return (await res.json()) as RuntimeSummaryDto;
    } catch {
      return null;
    }
  }
}
