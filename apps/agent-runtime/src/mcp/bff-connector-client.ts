import type { ConnectorConfig } from './transport';

const TIMEOUT_MS = 10_000;

export interface BffConnectorClientConfig {
  baseUrl: string;
  internalToken?: string;
  fetchImpl?: typeof fetch;
}

/** 调 BFF 内部端点拉取某租户启用的连接器（env 已解密）；非 2xx 一律抛错。 */
export async function fetchConnectors(
  cfg: BffConnectorClientConfig,
  tenantId: string,
): Promise<ConnectorConfig[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(
    `${cfg.baseUrl}/internal/connectors?tenantId=${encodeURIComponent(tenantId)}`,
    {
      method: 'GET',
      headers: {
        ...(cfg.internalToken ? { 'x-internal-token': cfg.internalToken } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('connectors_unreachable');
  }
  return (await res.json()) as ConnectorConfig[];
}
