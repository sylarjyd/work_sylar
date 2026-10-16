import type { McpToolInfo } from '@ai-office/shared';
import type { ConnectorConfig } from './transport';
import { StdioMcpTransport } from './stdio-transport';

export interface ValidateInput {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * 校验一个连接器：spawn 临时子进程 → initialize → tools/list → 立即销毁。
 * 临时进程与 McpHost 常驻池隔离，不进池。
 */
export async function validateConnector(
  input: ValidateInput,
  opts: { initTimeoutMs: number },
): Promise<McpToolInfo[]> {
  const cfg: ConnectorConfig = {
    id: '',
    name: 'validate',
    command: input.command,
    args: input.args,
    env: input.env,
    enabled: true,
  };
  const transport = new StdioMcpTransport(cfg, {
    initTimeoutMs: opts.initTimeoutMs,
    callTimeoutMs: opts.initTimeoutMs,
  });
  try {
    await transport.connect();
    return await transport.listTools();
  } finally {
    await transport.close().catch(() => undefined);
  }
}
