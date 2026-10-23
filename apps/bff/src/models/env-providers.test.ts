import { describe, expect, it } from 'vitest';
import {
  listEnvProviderGroups,
  parseEnvModelProviders,
  resolveEnvModelProviders,
} from './env-providers';

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
      { name: 'KEY_A', model: 'a', baseUrl: 'https://x/v1', modalities: ['text'], apiKey: 'sk-a' },
      { name: 'KEY_A', model: 'b', baseUrl: 'https://y/v1', modalities: ['text'], apiKey: 'sk-a' },
    ]);
  });

  it('MODEL_PROVIDERS 可声明 modalities，非法值忽略并回退纯文本', () => {
    const out = parseEnvModelProviders({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'vision', baseUrl: 'https://x/v1', apiKeyEnv: 'K', modalities: ['image', 'text', 'bogus'] },
        { model: 'tts', baseUrl: 'https://x/v1', apiKeyEnv: 'K', modalities: ['audio'] },
        { model: 'bad', baseUrl: 'https://x/v1', apiKeyEnv: 'K', modalities: ['bogus'] },
      ]),
      K: 'sk',
    });
    expect(out.map((m) => [m.model, m.modalities])).toEqual([
      ['vision', ['text', 'image']],
      ['tts', ['audio']],
      ['bad', ['text']],
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
    ).toEqual([
      { name: 'K', model: 'a', baseUrl: 'https://x/v1', modalities: ['text'], apiKey: 'sk' },
    ]);
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
        modalities: ['text'],
        apiKey: 'sk-d',
      },
    ]);
  });

  it('完全没有密钥时返回空数组（由 runtime 走 Mock）', () => {
    expect(parseEnvModelProviders({})).toEqual([]);
    expect(parseEnvModelProviders({ MODEL_PROVIDERS: JSON.stringify([{ model: 'a', baseUrl: 'https://x', apiKeyEnv: 'MISSING' }]) })).toEqual([
      { name: 'MISSING', model: 'a', baseUrl: 'https://x', modalities: ['text'], apiKey: '' },
    ]);
  });

  it('空 MODEL_NAME / MODEL_BASE_URL 按未设置处理', () => {
    expect(
      parseEnvModelProviders({ DEEPSEEK_API_KEY: 'sk-d', MODEL_NAME: '', MODEL_BASE_URL: '' }),
    ).toEqual([
      {
        name: 'default',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        modalities: ['text'],
        apiKey: 'sk-d',
      },
    ]);
  });

  it('Base URL 归一化后为空或 apiKeyEnv 指向原型键时不会误用', () => {
    expect(
      parseEnvModelProviders({
        MODEL_PROVIDERS: JSON.stringify([
          { model: 'a', baseUrl: '///', apiKeyEnv: 'K' },
          { model: 'b', baseUrl: 'https://x', apiKeyEnv: '__proto__' },
        ]),
        K: 'sk',
      }),
    ).toEqual([
      { name: '__proto__', model: 'b', baseUrl: 'https://x', modalities: ['text'], apiKey: '' },
    ]);
  });

  it('DEEPSEEK 的 MODEL_BASE_URL 归一化后为空时不产出可用配置', () => {
    expect(parseEnvModelProviders({ DEEPSEEK_API_KEY: 'sk-d', MODEL_BASE_URL: '///' })).toEqual([]);
    expect(resolveEnvModelProviders({ DEEPSEEK_API_KEY: 'sk-d', MODEL_BASE_URL: '/' })).toEqual([]);
  });
});

describe('resolveEnvModelProviders', () => {
  it('优先使用有密钥的 MODEL_PROVIDERS 条目，忽略缺密钥项', () => {
    expect(
      resolveEnvModelProviders({
        MODEL_PROVIDERS: JSON.stringify([
          { model: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'KEY_A' },
          { model: 'b', baseUrl: 'https://y/v1', apiKeyEnv: 'MISSING' },
        ]),
        KEY_A: 'sk-a',
        DEEPSEEK_API_KEY: 'sk-d',
      }),
    ).toEqual([
      { name: 'KEY_A', model: 'a', baseUrl: 'https://x/v1', modalities: ['text'], apiKey: 'sk-a' },
    ]);
  });

  it('MODEL_PROVIDERS 全部缺密钥时按 runtime 顺序回退 DEEPSEEK_API_KEY', () => {
    expect(
      resolveEnvModelProviders({
        MODEL_PROVIDERS: JSON.stringify([
          { model: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'MISSING' },
        ]),
        DEEPSEEK_API_KEY: 'sk-d',
        MODEL_NAME: 'deepseek-reasoner',
        MODEL_BASE_URL: 'https://d/v1/',
      }),
    ).toEqual([
      {
        name: 'default',
        model: 'deepseek-reasoner',
        baseUrl: 'https://d/v1',
        modalities: ['text'],
        apiKey: 'sk-d',
      },
    ]);
  });

  it('完全没有可用密钥时返回空数组', () => {
    expect(resolveEnvModelProviders({})).toEqual([]);
    expect(
      resolveEnvModelProviders({
        MODEL_PROVIDERS: JSON.stringify([{ model: 'a', baseUrl: 'https://x', apiKeyEnv: 'MISSING' }]),
      }),
    ).toEqual([]);
  });
});

describe('listEnvProviderGroups', () => {
  it('按 apiKeyEnv 归组且不泄露 baseUrl/密钥', () => {
    const groups = listEnvProviderGroups({
      MODEL_PROVIDERS: JSON.stringify([
        { model: 'a', baseUrl: 'http://secret-host', apiKeyEnv: 'KEY_A' },
        { model: 'b', baseUrl: 'http://secret-host', apiKeyEnv: 'KEY_A' },
      ]),
      KEY_A: 'sk-secret',
    });
    expect(groups).toEqual([{ name: 'KEY_A', models: ['a', 'b'] }]);
    expect(JSON.stringify(groups)).not.toContain('secret-host');
    expect(JSON.stringify(groups)).not.toContain('sk-secret');
  });

  it('什么都没配时展示运行时兜底的模型名', () => {
    expect(listEnvProviderGroups({ MODEL_NAME: 'deepseek-chat' })).toEqual([
      { name: 'default', models: ['deepseek-chat'] },
    ]);
  });
});
