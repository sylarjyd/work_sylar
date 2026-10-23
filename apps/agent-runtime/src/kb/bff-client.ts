import type { KbSearchHit } from '@ai-office/shared';

export interface KbSearchParams {
  vector: number[];
  topK: number;
  tenantId: string;
  userId: string;
  /** 助手限定的知识库 ID；缺省检索全部。 */
  kbIds?: string[];
}

const SEARCH_TIMEOUT_MS = 15_000;

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
    // 超时避免检索挂起拖住 agent loop；AbortError 由上层兜成 kb_search_unreachable。
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 回收失败响应体，避免连接池套接字悬挂。
    await res.body?.cancel().catch(() => undefined);
    throw new Error('kb_search_unreachable');
  }
  return (await res.json()) as KbSearchHit[];
}
