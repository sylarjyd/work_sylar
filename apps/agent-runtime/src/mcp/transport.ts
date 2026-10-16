import type { McpToolInfo } from '@ai-office/shared';

/** 连接器配置（runtime 从 BFF 拉取，env 已解密）。 */
export interface ConnectorConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

/** MCP 传输抽象：v1 只有 stdio；将来加 SSE/HTTP 只加一个实现。 */
export interface McpTransport {
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type TransportFactory = (cfg: ConnectorConfig) => McpTransport;
