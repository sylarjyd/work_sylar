import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpHost } from './host';
import type { ConnectorConfig, McpTransport } from './transport';

const cfg: ConnectorConfig = { id: 'c1', name: 'echo', command: 'node', args: ['s.mjs'], env: {}, enabled: true };

class FakeTransport implements McpTransport {
  connected = false;
  closed = false;
  pings = 0;
  constructor(private readonly behavior: { connectFails?: boolean; pingFails?: () => boolean }) {}
  async connect() { if (this.behavior.connectFails) throw new Error('spawn_failed'); this.connected = true; }
  async listTools() { return [{ name: 'echo', description: 'd', inputSchema: {} }]; }
  async callTool(_n: string, args: Record<string, unknown>) { return { text: `echo:${args.text}`, isError: false }; }
  async ping() { this.pings++; if (this.behavior.pingFails?.()) throw new Error('dead'); }
  async close() { this.closed = true; }
}

function makeHost(behavior: { connectFails?: boolean; pingFails?: () => boolean } = {}) {
  const made: FakeTransport[] = [];
  const host = new McpHost({
    heartbeatMs: 1000, backoffBaseMs: 100, backoffMaxMs: 400,
    initTimeoutMs: 5000, callTimeoutMs: 5000,
    transportFactory: () => { const t = new FakeTransport(behavior); made.push(t); return t; },
  });
  return { host, made };
}

afterEach(() => vi.useRealTimers());

describe('McpHost', () => {
  it('ensure 首次 spawn 并缓存工具；再次 ensure 复用（不再建连接）', async () => {
    const { host, made } = makeHost();
    expect(await host.ensure(cfg)).toHaveLength(1);
    expect(await host.ensure(cfg)).toHaveLength(1);
    expect(made).toHaveLength(1);
    await host.closeAll();
  });

  it('connect 失败：抛错、状态 error，并安排退避重拉', async () => {
    vi.useFakeTimers();
    const { host, made } = makeHost({ connectFails: true });
    await expect(host.ensure(cfg)).rejects.toThrow('spawn_failed');
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(made.length).toBeGreaterThanOrEqual(2); // 退避后重试
    await host.closeAll();
  });

  it('心跳 ping 失败：关闭子进程并按退避重拉', async () => {
    vi.useFakeTimers();
    let dead = false;
    const { host, made } = makeHost({ pingFails: () => dead });
    await host.ensure(cfg);
    dead = true;
    await vi.advanceTimersByTimeAsync(1100); // 触发心跳
    expect(made[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(made.length).toBeGreaterThanOrEqual(2);
    await host.closeAll();
  });

  it('call 路由到对应 transport；未 ready 的 server 抛错', async () => {
    const { host } = makeHost();
    await host.ensure(cfg);
    expect(await host.call('echo', 'echo', { text: 'hi' })).toEqual({ text: 'echo:hi', isError: false });
    await expect(host.call('nope', 'x', {})).rejects.toThrow('mcp_server_unavailable');
    await host.closeAll();
  });

  it('closeAll 关闭所有子进程', async () => {
    const { host, made } = makeHost();
    await host.ensure(cfg);
    await host.closeAll();
    expect(made[0].closed).toBe(true);
  });
});
