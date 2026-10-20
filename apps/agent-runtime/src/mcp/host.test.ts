import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpHost } from './host';
import type { ConnectorConfig, McpTransport } from './transport';

const cfg: ConnectorConfig = { id: 'c1', name: 'echo', command: 'node', args: ['s.mjs'], env: {}, enabled: true };

class FakeTransport implements McpTransport {
  connected = false;
  closed = false;
  pings = 0;
  constructor(
    private readonly behavior: {
      connectFails?: boolean;
      pingFails?: () => boolean;
      connectGate?: Promise<void>;
    },
  ) {}
  async connect() {
    if (this.behavior.connectGate) await this.behavior.connectGate;
    if (this.behavior.connectFails) throw new Error('spawn_failed');
    this.connected = true;
  }
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
    expect(await host.ensure('t1', cfg)).toHaveLength(1);
    expect(await host.ensure('t1', cfg)).toHaveLength(1);
    expect(made).toHaveLength(1);
    await host.closeAll();
  });

  it('connect 失败：抛错、状态 error，并安排退避重拉', async () => {
    vi.useFakeTimers();
    const { host, made } = makeHost({ connectFails: true });
    await expect(host.ensure('t1', cfg)).rejects.toThrow('spawn_failed');
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(made.length).toBeGreaterThanOrEqual(2); // 退避后重试
    await host.closeAll();
  });

  it('心跳 ping 失败：关闭子进程并按退避重拉', async () => {
    vi.useFakeTimers();
    let dead = false;
    const { host, made } = makeHost({ pingFails: () => dead });
    await host.ensure('t1', cfg);
    dead = true;
    await vi.advanceTimersByTimeAsync(1100); // 触发心跳
    expect(made[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(made.length).toBeGreaterThanOrEqual(2);
    await host.closeAll();
  });

  it('call 路由到对应 transport；未 ready 的 server 抛错', async () => {
    const { host } = makeHost();
    await host.ensure('t1', cfg);
    expect(await host.call('t1', 'echo', 'echo', { text: 'hi' })).toEqual({ text: 'echo:hi', isError: false });
    await expect(host.call('t1', 'nope', 'x', {})).rejects.toThrow('mcp_server_unavailable');
    await host.closeAll();
  });

  it('closeAll 关闭所有子进程', async () => {
    const { host, made } = makeHost();
    await host.ensure('t1', cfg);
    await host.closeAll();
    expect(made[0].closed).toBe(true);
  });

  it('并发 ensure 只建一个连接（in-flight 去重）', async () => {
    const { host, made } = makeHost();
    const [a, b] = await Promise.all([host.ensure('t1', cfg), host.ensure('t1', cfg)]);
    expect(a).toEqual(b);
    expect(made).toHaveLength(1);
    await host.closeAll();
  });

  it('closeAll 期间未完成的 spawn 不复活：回收连接并抛 mcp_host_closed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const made: FakeTransport[] = [];
    const host = new McpHost({
      heartbeatMs: 1000, backoffBaseMs: 100, backoffMaxMs: 400,
      initTimeoutMs: 5000, callTimeoutMs: 5000,
      transportFactory: () => {
        const t = new FakeTransport({ connectGate: gate });
        made.push(t);
        return t;
      },
    });
    const p = host.ensure('t1', cfg);
    await host.closeAll();
    release();
    await expect(p).rejects.toThrow('mcp_host_closed');
    expect(made[0].closed).toBe(true);
  });

  it('配置变更后 ensure 重建子进程并关闭旧连接', async () => {
    const { host, made } = makeHost();
    await host.ensure('t1', cfg);
    await host.ensure('t1', { ...cfg, args: ['other.mjs'] });
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    await host.closeAll();
  });

  it('等价配置（env 键序不同）不重建', async () => {
    const { host, made } = makeHost();
    await host.ensure('t1', { ...cfg, env: { A: '1', B: '2' } });
    await host.ensure('t1', { ...cfg, env: { B: '2', A: '1' } });
    expect(made).toHaveLength(1);
    await host.closeAll();
  });

  it('retain 回收不在集合中的连接器，需要时再重建', async () => {
    const { host, made } = makeHost();
    await host.ensure('t1', cfg);
    await host.retain('t1', new Set());
    expect(made[0].closed).toBe(true);
    await host.ensure('t1', cfg);
    expect(made).toHaveLength(2);
    await host.closeAll();
  });

  it('不同租户的同名连接器各自独立，retain 不影响其他租户', async () => {
    const { host, made } = makeHost();
    await host.ensure('t1', cfg);
    await host.ensure('t2', cfg);
    expect(made).toHaveLength(2); // 不因同名而复用
    await host.retain('t1', new Set());
    expect(made[0].closed).toBe(true);
    expect(made[1].closed).toBe(false);
    expect(await host.call('t2', 'echo', 'echo', { text: 'x' })).toEqual({
      text: 'echo:x',
      isError: false,
    });
    await host.closeAll();
  });

  it('进入 error 后重新拉起的成功连接回调 onRestart，首次建连不计重启', async () => {
    vi.useFakeTimers();
    const behavior = { connectFails: true };
    const restarted: string[] = [];
    const made: FakeTransport[] = [];
    const host = new McpHost({
      heartbeatMs: 1000,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      initTimeoutMs: 5000,
      callTimeoutMs: 5000,
      transportFactory: () => {
        const transport = new FakeTransport(behavior);
        made.push(transport);
        return transport;
      },
      onRestart: (server) => restarted.push(server),
    });

    await expect(host.ensure('t1', cfg)).rejects.toThrow('spawn_failed');
    expect(restarted).toEqual([]);

    behavior.connectFails = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(restarted).toEqual(['echo']);
    await host.closeAll();
  });
});
