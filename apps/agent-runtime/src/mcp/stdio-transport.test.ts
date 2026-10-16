import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildChildEnv } from './stdio-transport';

describe('buildChildEnv', () => {
  const original = process.env.DEEPSEEK_API_KEY;
  beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'sk-leak-me'; });
  afterEach(() => {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  });

  it('不把本服务密钥透给 MCP 子进程', () => {
    const env = buildChildEnv({ K: 'v' });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.K).toBe('v');
  });

  it('保留基础白名单（PATH 在 Windows/POSIX 均存在）', () => {
    const env = buildChildEnv({});
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it('连接器 env 覆盖同名键', () => {
    const env = buildChildEnv({ PATH: '/custom', EXTRA: '1' });
    expect(env.PATH).toBe('/custom');
    expect(env.EXTRA).toBe('1');
  });
});
