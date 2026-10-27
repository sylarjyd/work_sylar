import type { ChatOptions, ChatRequest, ChatResponse, ModelGateway } from './types';

/** 模型调用观测钩子；实现方不应抛错，否则会污染业务调用链。 */
export interface ModelObserver {
  onAttempt(model: string, ok: boolean, durationMs: number): void;
  onFallback(from: string, to: string): void;
}

/**
 * 给没有路由层的单模型网关补埋点：RoutingGateway 在每次尝试内部埋点，
 * 单模型网关没有这层循环，必须在外部包一层才能拿到成功/失败与耗时。
 */
export class ObservedGateway implements ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly model: string,
    private readonly observer: ModelObserver,
    private readonly now: () => number = Date.now,
  ) {}

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    const started = this.now();
    try {
      const res = await this.inner.chat(req, opts);
      this.observer.onAttempt(this.model, true, this.now() - started);
      return res;
    } catch (err) {
      this.observer.onAttempt(this.model, false, this.now() - started);
      throw err;
    }
  }
}
