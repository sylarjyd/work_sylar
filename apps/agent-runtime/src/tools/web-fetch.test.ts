import { describe, it, expect } from 'vitest';
import { htmlToText, createWebFetchTool } from './web-fetch';

describe('htmlToText', () => {
  it('剥离标签、脚本与多余空白', () => {
    const html = '<html><head><style>.a{}</style></head><body><h1>标题</h1><script>x=1</script><p>正  文</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('标题');
    expect(text).toContain('正 文');
    expect(text).not.toContain('<h1>');
    expect(text).not.toContain('x=1');
  });
});

describe('createWebFetchTool', () => {
  it('参数 schema 声明 url', () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe('web.fetch');
    expect(JSON.stringify(tool.parameters)).toContain('url');
  });
});
