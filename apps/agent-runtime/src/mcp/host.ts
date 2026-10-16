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

    const transport = this.factory(cfg);
    const prevBackoff = existing?.backoffMs ?? this.opts.backoffBaseMs;
    this.entries.set(cfg.name, {
      cfg, transport, state: 'starting', tools: [], backoffMs: prevBackoff,
    });
    try {
      await transport.connect();
      const tools = await transport.listTools();
      const entry = this.entries.get(cfg.name)!;
      entry.state = 'ready';
      entry.tools = tools;
      entry.backoffMs = this.opts.backoffBaseMs; // 成功后重置退避
      this.startHeartbeat(cfg.name, entry);
      return tools;
    } catch (err) {
      await transport.close().catch(() => undefined);
      this.markError(cfg.name);
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
    entry.heartbeatTimer = setInterval(() => void this.beat(name), this.opts.heartbeatMs);
    entry.heartbeatTimer.unref?.();
  }

  private async beat(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry || entry.state !== 'ready' || !entry.transport) return;
    try {
      await entry.transport.ping();
    } catch {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      await entry.transport.close().catch(() => undefined);
      entry.transport = null;
      this.markError(name);
    }
  }

  /** 置 error 并安排一次指数退避重拉；已 closed 则不再排期。 */
  private markError(name: string): void {
    if (this.closed) return;
    const entry = this.entries.get(name);
    if (!entry) return;
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    entry.state = 'error';
    entry.tools = [];
    const delay = Math.min(entry.backoffMs, this.opts.backoffMaxMs);
    entry.backoffMs = Math.min(entry.backoffMs * 2, this.opts.backoffMaxMs);
    const cfg = entry.cfg;
    entry.retryTimer = setTimeout(() => void this.ensure(cfg).catch(() => undefined), delay);
    entry.retryTimer.unref?.();
  }
}
