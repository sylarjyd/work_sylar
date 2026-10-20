import { endSpan, startSpan } from '@ai-office/telemetry';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';
import type { ModelObserver } from './observed-gateway';
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
  constructor(
    private readonly routes: ModelRoute[],
    private readonly observer?: ModelObserver,
  ) {}

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
    for (let i = 0; i < candidates.length; i++) {
      const route = candidates[i];
      const started = Date.now();
      // 每次尝试单独成 span：失败重试在 trace 里可见，而不是只看到最终成功那一次。
      const span = startSpan('model.chat', { 'gen_ai.request.model': route.model });
      try {
        const res = await route.gateway.chat(req);
        endSpan(span, true);
        this.observer?.onAttempt(route.model, true, Date.now() - started);
        return res;
      } catch (err) {
        endSpan(span, false, err);
        this.observer?.onAttempt(route.model, false, Date.now() - started);
        lastErr = err;
        if (!isRetryable(err)) throw err;
        const next = candidates[i + 1];
        if (next) this.observer?.onFallback(route.model, next.model);
      }
    }
    throw lastErr;
  }
}
