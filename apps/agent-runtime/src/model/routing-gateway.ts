import type { ChatRequest, ChatResponse, ModelGateway } from './types';
import { ModelHttpError } from './errors';

export interface ModelRoute {
  model: string;
  gateway: ModelGateway;
}

/** 仅网络错误、429、5xx 值得换模型；其余 4xx 多半是参数/鉴权问题，重试只会放大错误。 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ModelHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError;
}

/**
 * 多模型路由：按 req.models 的顺序选择已注册的模型；可重试错误切下一个。
 * 不读写账本——预算与结算都留在 BFF。
 */
export class RoutingGateway implements ModelGateway {
  constructor(private readonly routes: ModelRoute[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const allowed = req.models;
    let candidates = this.routes.filter((r) => !allowed || allowed.includes(r.model));
    if (allowed) {
      const order = new Map(allowed.map((m, i) => [m, i]));
      candidates = [...candidates].sort(
        (a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0),
      );
    }
    if (candidates.length === 0) throw new Error('model_not_allowed');

    let lastErr: unknown;
    for (const route of candidates) {
      try {
        return await route.gateway.chat(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
      }
    }
    throw lastErr;
  }
}
