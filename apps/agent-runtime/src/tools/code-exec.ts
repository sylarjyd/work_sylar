import { spawn as nodeSpawn } from 'node:child_process';
import type { Tool } from './types';

export interface CodeExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timeout?: boolean;
  truncated?: boolean;
}

type Spawn = typeof nodeSpawn;

interface Limits {
  timeoutMs: number;
  maxOldSpaceMb: number;
  maxOutputBytes: number;
}

/**
 * 受限 harness：读 stdin 取用户代码，在**无 require/process/网络**的作用域内执行，结果以 JSON 写 stdout。
 * 用 String.raw 保证 `\n` 原样进入子进程源码；harness 内不得出现 `${}`（会被模板插值）。
 * 用 `-e` 内联而非独立文件：runtime 构建为 tsup 单入口，附带的 .js 资产不会被拷进 dist。
 */
const HARNESS = String.raw`
const vm = require('node:vm');
const MAX_BYTES = Number(process.argv[1] || 65536);
const fmt = (x) => {
  if (typeof x === 'string') return x;
  try { const s = JSON.stringify(x); return s === undefined ? String(x) : s; } catch { return String(x); }
};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = [];
  let outLen = 0;
  const print = function () {
    const line = Array.prototype.map.call(arguments, fmt).join(' ');
    outLen += line.length + 1;
    if (outLen > MAX_BYTES) throw new Error('output_limit_exceeded');
    out.push(line);
  };
  // 受限作用域：仅暴露纯计算原语与 print，不暴露 require/process/fetch/网络。
  const sandbox = { print };
  let payload;
  try {
    const result = vm.runInNewContext(input, sandbox);
    payload = { ok: true, stdout: out.join('\n'), result: result === undefined ? null : fmt(result) };
  } catch (e) {
    payload = { ok: false, stdout: out.join('\n'), stderr: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(payload));
});
`;

interface HarnessOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function parseHarnessOutput(text: string): HarnessOutput | undefined {
  try {
    const v = JSON.parse(text) as { ok?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof v.ok !== 'boolean') return undefined;
    return {
      ok: v.ok,
      stdout: typeof v.stdout === 'string' ? v.stdout : '',
      stderr: typeof v.stderr === 'string' ? v.stderr : '',
    };
  } catch {
    return undefined;
  }
}

/** 在子进程沙箱内执行代码；返回结构化结果，**绝不抛出**（工具层只做透传）。 */
function runSandboxed(spawn: Spawn, code: string, limits: Limits): Promise<CodeExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let outBytes = 0;
    let stdout = '';
    let stderr = '';

    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--max-old-space-size=${limits.maxOldSpaceMb}`,
        '-e',
        HARNESS,
        String(limits.maxOutputBytes),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const finish = (r: Omit<CodeExecResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limits.timeoutMs);

    const collect = (into: 'out' | 'err') => (chunk: Buffer): void => {
      outBytes += chunk.length;
      if (outBytes > limits.maxOutputBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      if (into === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect('out'));
    child.stderr?.on('data', collect('err'));

    child.on('error', (err) => finish({ ok: false, stdout, stderr: String(err) }));
    child.on('close', () => {
      if (timedOut) return finish({ ok: false, stdout, stderr, timeout: true });
      if (truncated) return finish({ ok: false, stdout, stderr, truncated: true });
      const parsed = parseHarnessOutput(stdout);
      if (parsed) return finish({ ok: parsed.ok, stdout: parsed.stdout, stderr: parsed.stderr });
      return finish({ ok: false, stdout, stderr });
    });

    // 代码经 stdin 送入：避免为代码文件开 fs 读权限。
    child.stdin?.write(code);
    child.stdin?.end();
  });
}

/** 解析单次执行上限：请求值 ≤ 运行级上限 ≤ 服务端硬上限（60s）。 */
export function resolveTimeLimit(
  requested: unknown,
  ctxLimit: unknown,
  serverLimit: number,
): number {
  const server = Math.min(Math.max(serverLimit, 100), 60000);
  const ctxMax =
    typeof ctxLimit === 'number' && Number.isFinite(ctxLimit) && ctxLimit > 0
      ? Math.min(ctxLimit, server)
      : server;
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, ctxMax)
    : ctxMax;
}

export function createCodeExecTool(
  env: NodeJS.ProcessEnv = process.env,
  spawn: Spawn = nodeSpawn,
): Tool {
  const limits: Limits = {
    timeoutMs: Number(env.CODE_EXEC_TIMEOUT_MS ?? 5000),
    maxOldSpaceMb: Number(env.CODE_EXEC_MAX_OLD_SPACE_MB ?? 128),
    maxOutputBytes: Number(env.CODE_EXEC_MAX_OUTPUT_BYTES ?? 65536),
  };
  return {
    name: 'code.exec',
    description:
      '在受限沙箱中执行一段 JavaScript 代码（纯计算：无文件/网络/子进程），用 print() 输出结果。需用户确认后执行。',
    permission: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JavaScript 代码；用 print(...) 输出' },
        timeoutMs: { type: 'number', description: '可选：本次执行的墙钟上限（毫秒）' },
      },
      required: ['code'],
    },
    async execute(args, ctx) {
      const code = String(args.code ?? '');
      // 调用方只能收紧、不能放宽；运行级上限再收紧一次。
      const limit = resolveTimeLimit(args.timeoutMs, ctx?.codeExecTimeoutMs, limits.timeoutMs);
      return runSandboxed(spawn, code, { ...limits, timeoutMs: limit });
    },
  };
}
