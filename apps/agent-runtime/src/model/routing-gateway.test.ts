import { describe, it, expect } from 'vitest';
import { RoutingGateway } from './routing-gateway';
import { ModelHttpError } from './errors';
import type { ChatRequest, ChatResponse, ModelGateway } from './types';

const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

function ok(model: string): ChatResponse {
  return { content: model, toolCalls: [], usage: { input: 1, output: 1 }, model };
}

function gatewayOf(model: string, impl: 'ok' | '429' | '400' | 'network' | '500'): ModelGateway {
  return {
    async chat() {
      if (impl === 'ok') return ok(model);
      if (impl === 'network') throw new TypeError('fetch failed');
      throw new ModelHttpError(Number(impl), model);
    },
  };
}

describe('RoutingGateway', () => {
  it('按 req.models 的顺序选择首个可用模型', async () => {
    let called = '';
    const a: ModelGateway = {
      async chat() {
        called = 'a';
        return ok('a');
      },
    };
    const b: ModelGateway = {
      async chat() {
        called = 'b';
        return ok('b');
      },
    };
    const gw = new RoutingGateway([
      { model: 'a', gateway: a },
      { model: 'b', gateway: b },
    ]);
    const out = await gw.chat({ ...req, models: ['b', 'a'] });
    expect(out.model).toBe('b');
    expect(called).toBe('b');
  });

  it('429/5xx/网络错误切到下一个模型', async () => {
    const gw = new RoutingGateway([
      { model: 'a', gateway: gatewayOf('a', '429') },
      { model: 'b', gateway: gatewayOf('b', '500') },
      { model: 'c', gateway: gatewayOf('c', 'ok') },
    ]);
    const out = await gw.chat({ ...req, models: ['a', 'b', 'c'] });
    expect(out.model).toBe('c');
  });

  it('4xx（非 429）直接失败，不放大错误', async () => {
    let bCalled = false;
    const gw = new RoutingGateway([
      { model: 'a', gateway: gatewayOf('a', '400') },
      {
        model: 'b',
        gateway: {
          async chat() {
            bCalled = true;
            return ok('b');
          },
        },
      },
    ]);
    await expect(gw.chat({ ...req, models: ['a', 'b'] })).rejects.toBeInstanceOf(ModelHttpError);
    expect(bCalled).toBe(false);
  });

  it('允许模型与已注册模型无交集时报错，不静默绕过', async () => {
    const gw = new RoutingGateway([{ model: 'a', gateway: gatewayOf('a', 'ok') }]);
    await expect(gw.chat({ ...req, models: ['mock'] })).rejects.toThrow('model_not_allowed');
  });

  it('按必需模态跳过能力不足的候选', async () => {
    let textCalled = false;
    const gw = new RoutingGateway([
      {
        model: 'text-only',
        gateway: {
          async chat() {
            textCalled = true;
            return ok('text-only');
          },
        },
      },
      {
        model: 'vision',
        gateway: gatewayOf('vision', 'ok'),
        modalities: ['text', 'image'],
      },
    ]);

    const out = await gw.chat({
      ...req,
      models: ['text-only', 'vision'],
      requiredModalities: ['text', 'image'],
    });
    expect(out.model).toBe('vision');
    expect(textCalled).toBe(false);
  });

  it('没有模型支持所需模态时报 model_modality_unsupported', async () => {
    const gw = new RoutingGateway([
      { model: 'text-only', gateway: gatewayOf('text-only', 'ok') },
      { model: 'vision', gateway: gatewayOf('vision', 'ok'), modalities: ['text', 'image'] },
    ]);

    await expect(
      gw.chat({ ...req, models: ['text-only', 'vision'], requiredModalities: ['text', 'audio'] }),
    ).rejects.toThrow('model_modality_unsupported');
  });

  it('已经输出增量后失败不再切换模型，避免两段回答拼接', async () => {
    let bCalled = false;
    const a: ModelGateway = {
      async chat(_request, opts) {
        opts?.onDelta?.('半截', 'a');
        throw new ModelHttpError(500, 'a');
      },
    };
    const b: ModelGateway = {
      async chat() {
        bCalled = true;
        return ok('b');
      },
    };
    const gw = new RoutingGateway([
      { model: 'a', gateway: a },
      { model: 'b', gateway: b },
    ]);

    await expect(
      gw.chat({ ...req, models: ['a', 'b'] }, { onDelta: () => undefined }),
    ).rejects.toBeInstanceOf(ModelHttpError);
    expect(bCalled).toBe(false);
  });
});
