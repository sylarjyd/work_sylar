import type { McpToolInfo } from '@ai-office/shared';
import type { ConnectorConfig, McpTransport, TransportFactory } from './transport';
import { StdioMcpTransport } from './stdio-transport';

/** env 规范化为与键序无关的字符串，用于比较连接器配置是否变化。 */
function envKey(env: Record<string, string>): string {
  return Object.keys(env).sort().map((k) => `${k}\u0000${env[k]}`).join('\u0001');
}

/** 池内键带租户前缀：不同租户可用同名连接器，retain 也只回收本租户的条目。 */
function entryKey(tenantId: string, name: string): string {
  return `${tenantId}\u0000${name}`;
}

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
  /** 持有者租户；退避重拉时用于重建带前缀的键。 */
  tenantId: string;
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
 * MCP 子进程守护池：按 (tenantId, serverName) 复用常驻子进程，心跳巡检，
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

  private sameConfig(a: ConnectorConfig, b: ConnectorConfig): boolean {
    return (
      a.command === b.command &&
      a.args.join('\u0000') === b.args.join('\u0000') &&
      envKey(a.env) === envKey(b.env)
    );
  }

  /** 关闭并从池中移除某连接器（清定时器、回收子进程）；不存在则无操作。 */
  private async dispose(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    await entry.transport?.close().catch(() => undefined);
  }

  /** 确保某租户的连接器子进程就绪并返回其工具；失败抛错并安排退避重拉。 */
  async ensure(tenantId: string, cfg: ConnectorConfig): Promise<McpToolInfo[]> {
    const key = entryKey(tenantId, cfg.name);
    const existing = this.entries.get(key);
    if (existing?.state === 'ready' && this.sameConfig(existing.cfg, cfg)) {
      return existing.tools;
    }
    if (existing?.state === 'starting' && existing.connectPromise) {
      // 启动中：复用同一 in-flight promise（期间若有配置变更，留待下次 run 协调）。
      return existing.connectPromise;
    }
    const prevBackoff = existing?.backoffMs ?? this.opts.backoffBaseMs;
    if (existing) await this.dispose(key); // 配置变更 / error 态：先回收旧连接

    const transport = this.factory(cfg);
    const entry: Entry = {
      cfg, tenantId, transport, state: 'starting', tools: [], backoffMs: prevBackoff,
    };
    const promise = this.spawn(key, entry);
    entry.connectPromise = promise;
    this.entries.set(key, entry);
    return promise;
  }

  /** 关闭并移除该租户下不在 names 中的连接器（已删除/停用），不影响其他租户。 */
  async retain(tenantId: string, names: Set<string>): Promise<void> {
    const prefix = `${tenantId}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      if (!names.has(key.slice(prefix.length))) await this.dispose(key);
    }
  }

  private async spawn(key: string, entry: Entry): Promise<McpToolInfo[]> {
    const transport = entry.transport!;
    try {
      await transport.connect();
      const tools = await transport.listTools();
      // 期间若 host 已关闭或该 entry 被替换（并发/关闭），回收本次连接并放弃。
      if (this.closed || this.entries.get(key) !== entry) {
        await transport.close().catch(() => undefined);
        throw new Error('mcp_host_closed');
      }
      entry.state = 'ready';
      entry.tools = tools;
      entry.backoffMs = this.opts.backoffBaseMs; // 成功后重置退避
      entry.connectPromise = undefined;
      this.startHeartbeat(key, entry);
      return tools;
    } catch (err) {
      await transport.close().catch(() => undefined);
      entry.connectPromise = undefined;
      if (!this.closed && this.entries.get(key) === entry) this.markError(key, entry);
      throw err;
    }
  }

  async call(
    tenantId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const entry = this.entries.get(entryKey(tenantId, server));
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

  private startHeartbeat(key: string, entry: Entry): void {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = setInterval(
      () => void this.beat(key, entry).catch(() => undefined),
      this.opts.heartbeatMs,
    );
    entry.heartbeatTimer.unref?.();
  }

  private async beat(key: string, entry: Entry): Promise<void> {
    if (entry.state !== 'ready' || !entry.transport) return;
    try {
      await entry.transport.ping();
    } catch {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      const transport = entry.transport;
      entry.transport = null;
      await transport.close().catch(() => undefined);
      if (!this.closed && this.entries.get(key) === entry) this.markError(key, entry);
    }
  }

  /** 置 error 并安排一次指数退避重拉；已 closed 或 entry 已被替换则不再排期。 */
  private markError(key: string, entry: Entry): void {
    if (this.closed) return;
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.state = 'error';
    entry.tools = [];
    const delay = Math.min(entry.backoffMs, this.opts.backoffMaxMs);
    entry.backoffMs = Math.min(entry.backoffMs * 2, this.opts.backoffMaxMs);
    const cfg = entry.cfg;
    entry.retryTimer = setTimeout(
      () => void this.ensure(entry.tenantId, cfg).catch(() => undefined),
      delay,
    );
    entry.retryTimer.unref?.();
  }
}
