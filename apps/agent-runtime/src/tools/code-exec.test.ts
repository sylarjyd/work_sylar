import { describe, it, expect } from 'vitest';
import { createCodeExecTool, resolveTimeLimit } from './code-exec';

const tool = (env: NodeJS.ProcessEnv = {}) => createCodeExecTool(env);

describe('code.exec 沙箱', () => {
  it('正常计算并捕获 print 输出', async () => {
    const r = (await tool().execute({ code: 'print(1 + 1)' })) as { ok: boolean; stdout: string };
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('2');
  });

  it('沙箱内 require / process / fetch 均不可达', async () => {
    const r = (await tool().execute({
      code: 'print(typeof require, typeof process, typeof fetch)',
    })) as { ok: boolean; stdout: string };
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe('undefined undefined undefined');
  });

  it('require 逃逸尝试以失败告终', async () => {
    const r = (await tool().execute({ code: "require('node:fs')" })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it('死循环被墙钟超时 kill', async () => {
    const r = (await tool().execute({ code: 'while (true) {}', timeoutMs: 300 })) as {
      ok: boolean;
      timeout?: boolean;
    };
    expect(r.ok).toBe(false);
    expect(r.timeout).toBe(true);
  }, 10_000);

  it('内存炸弹以 OOM 失败', async () => {
    const t = createCodeExecTool({ CODE_EXEC_MAX_OLD_SPACE_MB: '32' });
    const r = (await t.execute({
      code: 'const a = []; for (;;) { a.push(new Array(1e6).fill(1)); }',
    })) as { ok: boolean };
    expect(r.ok).toBe(false);
  }, 20_000);

  it('输出炸弹触发截断失败', async () => {
    const t = createCodeExecTool({ CODE_EXEC_MAX_OUTPUT_BYTES: '4096' });
    const r = (await t.execute({ code: "for (;;) { print('x'.repeat(1000)); }" })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
  }, 10_000);

  it('工具契约：名称、confirm 权限与 code 参数', () => {
    const t = tool();
    expect(t.name).toBe('code.exec');
    expect(t.permission).toBe('confirm');
    expect(JSON.stringify(t.parameters)).toContain('code');
  });
});

describe('resolveTimeLimit', () => {
  it('调用方只能收紧，不能放宽服务端上限', () => {
    expect(resolveTimeLimit(999999, undefined, 5000)).toBe(5000);
    expect(resolveTimeLimit(1000, undefined, 5000)).toBe(1000);
  });

  it('运行级上限进一步收紧服务端上限', () => {
    expect(resolveTimeLimit(undefined, 2000, 5000)).toBe(2000);
    expect(resolveTimeLimit(4000, 2000, 5000)).toBe(2000);
    expect(resolveTimeLimit(500, 2000, 5000)).toBe(500);
  });

  it('服务端上限硬夹到 60s', () => {
    expect(resolveTimeLimit(undefined, undefined, 120000)).toBe(60000);
    expect(resolveTimeLimit(undefined, 90000, 5000)).toBe(5000);
  });
});
