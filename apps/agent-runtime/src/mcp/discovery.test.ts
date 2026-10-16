import { describe, it, expect, vi } from 'vitest';
import { buildMcpTools } from './discovery';
import type { ConnectorConfig } from './transport';
import type { McpHost } from './host';

const ctx = { tenantId: 't1', userId: 'u1', sessionId: 's1', runId: 'r1' };

function fakeHost(overrides: Partial<McpHost> = {}): McpHost {
  return {
    ensure: async (cfg: ConnectorConfig) => [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }],
    call: async (_s: string, _t: string, args: Record<string, unknown>) => ({ text: `echo:${args.text}`, isError: false }),
    ...overrides,
  } as unknown as McpHost;
}

const cfg: ConnectorConfig = { id: 'c1', name: 'fb', command: 'node', args: [], env: {}, enabled: true };

describe('buildMcpTools', () => {
  it('命名 mcp.<server>.<tool>，permission=confirm，parameters 取 inputSchema', async () => {
    const tools = await buildMcpTools([cfg], fakeHost());
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp.fb.echo');
    expect(tools[0].permission).toBe('confirm');
    expect(tools[0].parameters).toEqual({ type: 'object' });
  });

  it('execute 成功回填 text', async () => {
    const tools = await buildMcpTools([cfg], fakeHost());
    expect(await tools[0].execute({ text: 'hi' }, ctx)).toMatchObject({ ok: true, text: 'echo:hi' });
  });

  it('execute 失败（host 抛错）回结构化 ok:false，不抛穿', async () => {
    const host = fakeHost({ call: async () => { throw new Error('boom'); } });
    const tools = await buildMcpTools([cfg], host);
    expect(await tools[0].execute({}, ctx)).toMatchObject({ ok: false, error: 'mcp_call_failed' });
  });

  it('单个 Server 拉起失败不影响其他，且跳过 disabled', async () => {
    const bad: ConnectorConfig = { ...cfg, id: 'c2', name: 'bad' };
    const disabled: ConnectorConfig = { ...cfg, id: 'c3', name: 'off', enabled: false };
    const host = fakeHost({
      ensure: async (c: ConnectorConfig) => { if (c.name === 'bad') throw new Error('spawn_failed'); return [{ name: 'echo', description: '', inputSchema: {} }]; },
    });
    const tools = await buildMcpTools([cfg, bad, disabled], host);
    expect(tools.map((t) => t.name)).toEqual(['mcp.fb.echo']);
  });

  it('disabled 连接器不触发 ensure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const host = fakeHost({
        ensure: async (c: ConnectorConfig) => { calls.push(c.name); return [{ name: 'echo', description: '', inputSchema: {} }]; },
      });
      const disabled: ConnectorConfig = { ...cfg, id: 'c3', name: 'off', enabled: false };
      await buildMcpTools([disabled], host);
      expect(calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('同名工具只保留一个并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host = fakeHost({
        ensure: async () => [
          { name: 'echo', description: '', inputSchema: {} },
          { name: 'echo', description: '', inputSchema: {} },
        ],
      });
      const tools = await buildMcpTools([cfg], host);
      expect(tools.map((t) => t.name)).toEqual(['mcp.fb.echo']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
