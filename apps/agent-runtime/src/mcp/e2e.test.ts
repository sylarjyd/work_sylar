import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { McpHost } from './host';
import { buildMcpTools } from './discovery';
import type { ConnectorConfig } from './transport';

const fixture = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));

const cfg: ConnectorConfig = {
  id: 'c1',
  name: 'echo',
  command: process.execPath, // 当前 node 可执行文件
  args: [fixture],
  env: {},
  enabled: true,
};

let host: McpHost | undefined;
afterEach(async () => { await host?.closeAll(); host = undefined; });

describe('端到端：接入 MCP Server 后其工具可用', () => {
  it('发现 echo 工具并可调用成功', async () => {
    host = new McpHost({
      heartbeatMs: 60_000, backoffBaseMs: 500, backoffMaxMs: 1000,
      initTimeoutMs: 20_000, callTimeoutMs: 20_000,
    });
    const tools = await buildMcpTools([cfg], host);
    expect(tools.map((t) => t.name)).toEqual(['mcp.echo.echo']);
    expect(tools[0].permission).toBe('confirm');

    const out = await tools[0].execute({ text: '你好' }, { tenantId: 't1', userId: 'u1', sessionId: 's1', runId: 'r1' });
    expect(out).toMatchObject({ ok: true, tool: 'mcp.echo.echo', text: 'echo:你好' });
  });
});
