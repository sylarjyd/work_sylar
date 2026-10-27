import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

function render(md: string): string {
  return renderToStaticMarkup(createElement(Markdown, null, md));
}

describe('Markdown', () => {
  it('渲染标题、加粗、删除线与 GFM 列表', () => {
    const html = render('## 结论\n\n- **要点一**\n- ~~已废弃~~\n- 普通条目');
    expect(html).toContain('<h2>结论</h2>');
    expect(html).toContain('<strong>要点一</strong>');
    expect(html).toContain('<del>已废弃</del>');
    expect(html).toContain('<li>普通条目</li>');
  });

  it('外链新窗口打开，内链保持当前页', () => {
    const external = render('[示例](https://example.com/a)');
    expect(external).toContain('href="https://example.com/a"');
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');

    const internal = render('[知识库](/kb)');
    expect(internal).toContain('href="/kb"');
    expect(internal).not.toContain('target="_blank"');
  });

  it('GFM 表格渲染到可滚动容器里', () => {
    const html = render('| 指标 | 数值 |\n| --- | ---: |\n| 营收 | 120 |');
    expect(html).toContain('class="wb-md-table"');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>指标</th>');
    expect(html).toContain('<td>营收</td>');
  });

  it('围栏代码块走高亮与复制按钮，行内代码保持轻量', () => {
    const block = render('```ts\nconst answer = 42;\n```');
    expect(block).toContain('class="wb-md-code"');
    expect(block).toContain('hljs');
    expect(block).toContain('aria-label="复制代码"');
    expect(block).toContain('复制');

    const inline = render('安装 `@ai-office/web` 后运行');
    expect(inline).toContain('<code>@ai-office/web</code>');
    expect(inline).not.toContain('wb-md-code');
  });

  it('原始 HTML 一律转义，危险链接被清洗', () => {
    const html = render('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
  });
});
