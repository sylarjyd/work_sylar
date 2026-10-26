import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunModelRoute } from '@ai-office/shared';
import { MODEL_ENC_KEY } from './model.constants';
import { sealRoutes, unsealRoutes } from './run-routes';

const ENC_KEY_HEX = 'e'.repeat(64);

beforeEach(() => {
  process.env.MODEL_ENC_KEY = ENC_KEY_HEX;
});

describe('run-routes', () => {
  it('sealRoutes 加密密钥且 unsealRoutes 可还原', () => {
    const routes: RunModelRoute[] = [
      { model: 'm1', baseUrl: 'https://ark.example/v3', apiKey: 'sk-plain', modalities: ['text'] },
      { model: 'm2', baseUrl: 'https://other.example/v1', apiKey: 'sk-two' },
    ];

    const sealed = sealRoutes(routes);
    expect(sealed).toHaveLength(2);
    expect(sealed[0]!.apiKey).not.toBe('sk-plain');
    expect(sealed[1]!.apiKey).not.toBe('sk-two');
    // 除密钥外的字段原样保留。
    expect(sealed[0]!.model).toBe('m1');
    expect(sealed[0]!.modalities).toEqual(['text']);

    expect(unsealRoutes(sealed)).toEqual(routes);
  });

  it('空路由原样往返', () => {
    expect(sealRoutes([])).toEqual([]);
    expect(unsealRoutes([])).toEqual([]);
  });

  it('密钥被篡改时解密抛错', () => {
    const sealed = sealRoutes([{ model: 'm1', baseUrl: 'https://x.example', apiKey: 'sk-plain' }]);
    expect(() => unsealRoutes([{ ...sealed[0]!, apiKey: 'broken' }])).toThrow();
  });
});
