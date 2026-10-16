import type { McpToolInfo } from '@ai-office/shared';
import type { ConnectorConfig, McpTransport, TransportFactory } from './transport';
import { StdioMcpTransport } from './stdio-transport';

export interface McpHostOptions {
  heartbeatMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  initTimeoutMs: number;
  callTimeoutMs: number;
  /** 测试注入；默认建 stdio 传输。 */
  transportFactory?: TransportFactory;
}

type State = 'starting' | 'ready' | 'error';

interface Entry {
  cfg: ConnectorConfig;
  transport: McpTransport | null;
  state: State;
  tools: McpToolInfo[];
  backoffMs: number;
  /** 进行中的 spawn；并发 ensure 共用同一 promise，避免重复建连接。 */
  connectPromise?: Promise<McpToolInfo[]>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * MCP 子进程守护池：按 serverName 复用常驻子进程，心跳巡检，
 * 崩溃后指数退避重拉。实例随 runtime 进程存活（见 server.ts closeAll）。
 */
export class McpHost {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly opts: McpHostOptions) {}

  private factory(cfg: ConnectorConfig): McpTransport {
    if (this.opts.transportFactory) return this.opts.transportFactory(cfg);
    return new StdioMcpTransport(cfg, {
      initTimeoutMs: this.opts.initTimeoutMs,
      callTimeoutMs: this.opts.callTimeoutMs,
    });
  }

  /** 确保某连接器子进程就绪并返回其工具；失败抛错并安排退避重拉。 */
  async ensure(cfg: ConnectorConfig): Promise<McpToolInfo[]> {
    const existing = this.entries.get(cfg.name);
    if (existing?.state === 'ready') return existing.tools;
    if (existing?.state === 'starting' && existing.connectPromise) {
      return existing.connectPromise;
    }

    const transport = this.factory(cfg);
    const prevBackoff = existing?.backoffMs ?? this.opts.backoffBaseMs;
    const entry: Entry = {
      cfg, transport, state: 'starting', tools: [], backoffMs: prevBackoff,
    };
    const promise = this.spawn(cfg.name, entry);
    entry.connectPromise = promise;
    this.entries.set(cfg.name, entry);
    return promise;
  }

  private async spawn(name: string, entry: Entry): Promise<McpToolInfo[]> {
    const transport = entry.transport!;
    try {
      await transport.connect();
      const tools = await transport.listTools();
      // 期间若 host 已关闭或该 entry 被替换（并发/关闭），回收本次连接并放弃。
      if (this.closed || this.entries.get(name) !== entry) {
        await transport.close().catch(() => undefined);
        throw new Error('mcp_host_closed');
      }
      entry.state = 'ready';
      entry.tools = tools;
      entry.backoffMs = this.opts.backoffBaseMs; // 成功后重置退避
      entry.connectPromise = undefined;
      this.startHeartbeat(name, entry);
      return tools;
    } catch (err) {
      await transport.close().catch(() => undefined);
      entry.connectPromise = undefined;
      if (!this.closed && this.entries.get(name) === entry) this.markError(name, entry);
      throw err;
    }
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const entry = this.entries.get(server);
    if (!entry || entry.state !== 'ready' || !entry.transport) {
      throw new Error('mcp_server_unavailable');
    }
    return entry.transport.callTool(tool, args);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      await entry.transport?.close().catch(() => undefined);
    }
    this.entries.clear();
  }

  private startHeartbeat(name: string, entry: Entry): void {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = setInterval(
      () => void this.beat(name, entry).catch(() => undefined),
      this.opts.heartbeatMs,
    );
    entry.heartbeatTimer.unref?.();
  }

  private async beat(name: string, entry: Entry): Promise<void> {
    if (entry.state !== 'ready' || !entry.transport) return;
    try {
      await entry.transport.ping();
    } catch {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      const transport = entry.transport;
      entry.transport = null;
      await transport.close().catch(() => undefined);
      if (!this.closed && this.entries.get(name) === entry) this.markError(name, entry);
    }
  }

  /** 置 error 并安排一次指数退避重拉；已 closed 或 entry 已被替换则不再排期。 */
  private markError(name: string, entry: Entry): void {
    if (this.closed) return;
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.state = 'error';
    entry.tools = [];
    const delay = Math.min(entry.backoffMs, this.opts.backoffMaxMs);
    entry.backoffMs = Math.min(entry.backoffMs * 2, this.opts.backoffMaxMs);
    const cfg = entry.cfg;
    entry.retryTimer = setTimeout(() => void this.ensure(cfg).catch(() => undefined), delay);
    entry.retryTimer.unref?.();
  }
}
