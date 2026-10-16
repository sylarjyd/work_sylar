import type { Tool } from '../tools/types';
import type { McpHost } from './host';
import type { ConnectorConfig } from './transport';

/**
 * 把连接器聚合为本次 run 的 MCP 工具：名 `mcp.<server>.<tool>`、`permission:'confirm'`。
 * 单个 Server 拉起失败只跳过它，不影响其他工具与 agent loop。
 */
export async function buildMcpTools(
  connectors: ConnectorConfig[],
  host: McpHost,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const cfg of connectors) {
    if (!cfg.enabled) continue;
    let infos;
    try {
      infos = await host.ensure(cfg);
    } catch {
      continue; // 记日志由 host 承担；此处静默跳过该 Server。
    }
    for (const info of infos) {
      const name = `mcp.${cfg.name}.${info.name}`;
      tools.push({
        name,
        description: info.description || `MCP 工具 ${cfg.name}/${info.name}`,
        parameters: info.inputSchema ?? { type: 'object', properties: {} },
        permission: 'confirm',
        async execute(args): Promise<unknown> {
          try {
            const out = await host.call(cfg.name, info.name, args);
            return { ok: !out.isError, tool: name, text: out.text };
          } catch {
            // 调用失败不中断 loop：回结构化失败，模型据此说明。
            return { ok: false, tool: name, error: 'mcp_call_failed', text: '外部工具暂时不可用' };
          }
        },
      });
    }
  }
  return tools;
}
