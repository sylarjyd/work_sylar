import { describe, expect, it } from 'vitest';
import { listEnvProviderGroups, parseEnvModelProviders } from './env-providers';

describe('parseEnvModelProviders', () => {
  it('解析 MODEL_PROVIDERS 并按 apiKeyEnv 取名与密钥', () => {
    const out = parseEnvModelProviders({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'https://x/v1/', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'https://y/v1', apiKeyEnv: 'KEY_A' },
      ]),
      KEY_A: 'sk-a',
    });
    expect(out).toEqual([
      { name: 'KEY_A', model: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-a' },
      { name: 'KEY_A', model: 'b', baseUrl: 'https://y/v1', apiKey: 'sk-a' },
    ]);
  });

  it('非法 JSON / 非数组 / 空字段与重复模型被忽略', () => {
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: '{bad' })).toEqual([]);
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: '{}' })).toEqual([]);
    expect(
      parseEnvModelProviders({
        MODEL_PROVIDERS: JSON.stringify([
          { model: '', baseUrl: 'https://x/v1', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: '', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'K' },
          { model: 'a', baseUrl: 'https://y/v1', apiKeyEnv: 'K' },
        ]),
        K: 'sk',
      }),
    ).toEqual([{ name: 'K', model: 'a', baseUrl: 'https://x/v1', apiKey: 'sk' }]);
  });

  it('未配置 MODEL_PROVIDERS 时回退 DEEPSEEK_API_KEY 单模型', () => {
    expect(
      parseEnvModelProviders({
        DEEPSEEK_API_KEY: 'sk-d',
        MODEL_BASE_URL: 'https://d/v1/',
        MODEL_NAME: 'deepseek-reasoner',
      }),
    ).toEqual([
      {
        name: 'default',
        model: 'deepseek-reasoner',
        baseUrl: 'https://d/v1',
        apiKey: 'sk-d',
      },
    ]);
  });

  it('完全没有密钥时返回空数组（由 runtime 走 Mock）', () => {
    expect(parseEnvModelProviders({})).toEqual([]);
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: JSON.stringify([{ model: 'a', baseUrl: 'https://x', apiKeyEnv: 'MISSING' }]) })).toEqual([
      { name: 'MISSING', model: 'a', baseUrl: 'https://x', apiKey: '' },
    ]);
  });
});

describe('listEnvProviderGroups', () => {
  it('按 apiKeyEnv 归组且不泄露 baseUrl/密钥', () => {
    const groups = listEnvProviderGroups({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'http://secret-host', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'http://secret-host', apiKeyEnv: 'KEY_A' },
      ]),
    });
    expect(groups).toEqual([{ name: 'KEY_A', models: ['a', 'b'] }]);
    expect(JSON.stringify(groups)).not.toContain('secret-host');
  });

  it('什么都没配时展示运行时兜底的模型名', () => {
    expect(listEnvProviderGroups({ MODEL_NAME: 'deepseek-chat' })).toEqual([
      { name: 'default', models: ['deepseek-chat'] },
    ]);
  });
});
