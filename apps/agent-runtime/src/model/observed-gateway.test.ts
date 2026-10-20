import { describe, expect, it } from 'vitest';
import { createGateway } from './create-gateway';
import { ObservedGateway } from './observed-gateway';
import { RoutingGateway } from './routing-gateway';
import { ModelHttpError } from './errors';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

function ok(model: string): ChatResponse {
  return { content: model, toolCalls: [], usage: { input: 1, output: 1 }, model };
}

describe('model observer', () => {
  it('RoutingGateway 逐次记录尝试，可重试失败后记录 fallback', async () => {
    const events: string[] = [];
    const observer = {
      onAttempt: (model: string, okResult: boolean) => events.push(`${model}:${okResult}`),
      onFallback: (from: string, to: string) => events.push(`fallback:${from}->${to}`),
    };
    const gateway = new RoutingGateway(
      [
        {
          model: 'a',
          gateway: {
            async chat() {
              throw new ModelHttpError(500, 'a');
            },
          },
        },
        { model: 'b', gateway: { async chat() { return ok('b'); } } },
      ],
      observer,
    );
    const res = await gateway.chat(req);
    expect(res.model).toBe('b');
    expect(events).toEqual(['a:false', 'fallback:a->b', 'b:true']);
  });

  it('不可重试错误不记录 fallback', async () => {
    const events: string[] = [];
    const gateway = new RoutingGateway(
      [
        {
          model: 'a',
          gateway: {
            async chat() {
              throw new ModelHttpError(400, 'a');
            },
          },
        },
        { model: 'b', gateway: { async chat() { return ok('b'); } } },
      ],
      {
        onAttempt: (model, okResult) => events.push(`${model}:${okResult}`),
        onFallback: (from, to) => events.push(`fallback:${from}->${to}`),
      },
    );
    await expect(gateway.chat(req)).rejects.toBeInstanceOf(ModelHttpError);
    expect(events).toEqual(['a:false']);
  });

  it('ObservedGateway 为单模型网关补埋点并透传结果', async () => {
    const events: string[] = [];
    let clock = 1000;
    const inner: ModelGateway = {
      async chat() {
        clock += 120;
        return ok('x');
      },
    };
    const gateway = new ObservedGateway(
      inner,
      'x',
      {
        onAttempt: (model, okResult, durationMs) =>
          events.push(`${model}:${okResult}:${durationMs}`),
        onFallback: () => undefined,
      },
      () => clock,
    );
    const res = await gateway.chat(req);
    expect(res.model).toBe('x');
    expect(events).toEqual(['x:true:120']);
  });

  it('createGateway 不传 observer 时保持原有实例类型', () => {
    expect(createGateway({}).constructor.name).toBe('MockGateway');
  });

  it('createGateway 传 observer 时包装单模型网关', () => {
    const gateway = createGateway({}, {
      onAttempt: () => undefined,
      onFallback: () => undefined,
    });
    expect(gateway).toBeInstanceOf(ObservedGateway);
  });
});
