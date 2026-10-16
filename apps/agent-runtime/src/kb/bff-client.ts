import type { KbSearchHit } from '@ai-office/shared';

export interface KbSearchParams {
  vector: number[];
  topK: number;
  tenantId: string;
  userId: string;
}

export interface KbClientConfig {
  baseUrl: string;
  internalToken?: string;
  fetchImpl?: typeof fetch;
}

/** 调 BFF 内部检索端点；非 2xx 一律抛 kb_search_unreachable（由调用方兜成结构化结果）。 */
export async function searchKb(cfg: KbClientConfig, params: KbSearchParams): Promise<KbSearchHit[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.baseUrl}/internal/kb/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.internalToken ? { 'x-internal-token': cfg.internalToken } : {}),
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error('kb_search_unreachable');
  return (await res.json()) as KbSearchHit[];
}
