import { describe, it, expect } from 'vitest';
import { createTools } from './registry';

describe('createTools', () => {
  it('返回 web / doc / file / code / kb / chart 共九个工具，且元数据完整（不触发网络）', () => {
    const tools = createTools({});
    expect(tools.map((t) => t.name)).toEqual([
      'web.search',
      'web.fetch',
      'doc.docx',
      'doc.xlsx',
      'doc.pptx',
      'file.write',
      'code.exec',
      'kb.retrieve',
      'chart.render',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe('object');
      expect(tool.parameters).not.toBeNull();
    }
  });
});
