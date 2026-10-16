import { describe, it, expect, vi, beforeEach } from 'vitest';

const connect = vi.fn(async () => {});
const listTools = vi.fn(async () => [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }]);
const close = vi.fn(async () => {});

vi.mock('./stdio-transport', () => ({
  StdioMcpTransport: class {
    connect = connect;
    listTools = listTools;
    close = close;
  },
}));

import { validateConnector } from './validate';

beforeEach(() => { connect.mockClear(); listTools.mockClear(); close.mockClear(); });

describe('validateConnector', () => {
  it('握手 + 列工具并销毁临时进程，返回工具摘要', async () => {
    const tools = await validateConnector({ command: 'node', args: ['s.mjs'], env: {} }, { initTimeoutMs: 1000 });
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('握手失败仍销毁进程并抛错', async () => {
    connect.mockRejectedValueOnce(new Error('spawn_failed'));
    await expect(validateConnector({ command: 'nope', args: [], env: {} }, { initTimeoutMs: 1000 })).rejects.toThrow('spawn_failed');
    expect(close).toHaveBeenCalledOnce();
  });
});
