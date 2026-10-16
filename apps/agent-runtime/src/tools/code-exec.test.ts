import { describe, it, expect } from 'vitest';
import { createCodeExecTool } from './code-exec';

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
