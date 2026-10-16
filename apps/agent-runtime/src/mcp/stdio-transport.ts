import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpToolInfo } from '@ai-office/shared';
import type { ConnectorConfig, McpTransport } from './transport';

export interface StdioTransportOptions {
  initTimeoutMs: number;
  callTimeoutMs: number;
}

/**
 * 子进程环境 = SDK 白名单（PATH/HOME 等）合并连接器 env。
 * **绝不注入完整 process.env**：否则会把 DEEPSEEK_API_KEY / JWT_SECRET 等
 * 本服务密钥泄露给任意第三方 MCP Server。
 */
export function buildChildEnv(connectorEnv: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...connectorEnv };
}

/** 带超时的 promise 包装；超时抛 `<label>_timeout` 且不再等待原 promise。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
    t.unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** stdio MCP 传输：封装官方 SDK Client + StdioClientTransport。 */
export class StdioMcpTransport implements McpTransport {
  private readonly client: Client;

  constructor(
    private readonly cfg: ConnectorConfig,
    private readonly opts: StdioTransportOptions,
  ) {
    this.client = new Client({ name: 'ai-office-agent', version: '1.0.0' });
  }

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args,
      env: buildChildEnv(this.cfg.env),
    });
    try {
      await withTimeout(this.client.connect(transport), this.opts.initTimeoutMs, 'mcp_init');
    } catch (err) {
      // 初始化失败（含超时）时 SDK 已 spawn 子进程，必须 close 回收，否则遗留孤儿子进程
      await this.client.close().catch(() => {});
      throw err;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const { tools } = await withTimeout(
      this.client.listTools(),
      this.opts.callTimeoutMs,
      'mcp_list_tools',
    );
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = await withTimeout(
      this.client.callTool({ name, arguments: args }),
      this.opts.callTimeoutMs,
      'mcp_call',
    );
    const content = (res.content ?? []) as { type?: string; text?: string }[];
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return { text, isError: res.isError === true };
  }

  async ping(): Promise<void> {
    await withTimeout(this.client.ping(), this.opts.callTimeoutMs, 'mcp_ping');
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
