import { describe, it, expect } from 'vitest';
import { createTools } from './registry';

describe('createTools', () => {
  it('返回 web.search 与 web.fetch 两个工具，且元数据完整（不触发网络）', () => {
    const tools = createTools({});
    expect(tools.map((t) => t.name)).toEqual(['web.search', 'web.fetch']);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe('object');
      expect(tool.parameters).not.toBeNull();
    }
  });
});
