import { describe, it, expect, vi } from 'vitest';
import { htmlToText, createWebFetchTool, isBlockedIp } from './web-fetch';

/** 单测替身：把任意主机名解析成公网地址，避免真实 DNS 查询。 */
const publicResolve = async () => ['93.184.216.34'];

describe('htmlToText', () => {
  it('剥离标签、脚本与多余空白', () => {
    const html = '<html><head><style>.a{}</style></head><body><h1>标题</h1><script>x=1</script><p>正  文</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('标题');
    expect(text).toContain('正 文');
    expect(text).not.toContain('<h1>');
    expect(text).not.toContain('x=1');
  });

  it('先解 &lt;/&gt; 再解 &amp;，&amp;lt; 不被误当成 <', () => {
    expect(htmlToText('<p>&amp;lt;</p>')).toBe('&lt;');
  });
});

describe('isBlockedIp', () => {
  it('拦截环回/私网/链路本地/云元数据/保留段', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '192.0.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fec0::1',
      'fd00::1',
      'ff02::1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('放行公网地址', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('createWebFetchTool', () => {
  it('参数 schema 声明 url', () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe('web.fetch');
    expect(JSON.stringify(tool.parameters)).toContain('url');
  });

  it('非法 URL 直接拒绝，不发起请求', async () => {
    const fetcher = vi.fn(async () => new Response('x')) as unknown as typeof fetch;
    const tool = createWebFetchTool(fetcher, publicResolve);
    await expect(tool.execute({ url: 'ftp://x' })).rejects.toThrow('invalid_url');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('主机解析到内网地址时拒绝，不发起请求', async () => {
    const fetcher = vi.fn(async () => new Response('x')) as unknown as typeof fetch;
    const tool = createWebFetchTool(fetcher, async () => ['169.254.169.254']);
    await expect(tool.execute({ url: 'https://metadata.example/' })).rejects.toThrow('blocked_host');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('多地址里只要含一条内网地址即拒绝', async () => {
    const fetcher = vi.fn(async () => new Response('x')) as unknown as typeof fetch;
    const tool = createWebFetchTool(fetcher, async () => ['93.184.216.34', '10.0.0.5']);
    await expect(tool.execute({ url: 'https://mixed.example/' })).rejects.toThrow('blocked_host');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('拒绝重定向，避免 3xx 绕过 host 校验', async () => {
    const fetcher = (async () =>
      new Response('', { status: 302 })) as unknown as typeof fetch;
    const tool = createWebFetchTool(fetcher, publicResolve);
    await expect(tool.execute({ url: 'https://e.com' })).rejects.toThrow('redirect_blocked');
  });

  it('非 2xx 响应抛出契约错误', async () => {
    const fetcher = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const tool = createWebFetchTool(fetcher, publicResolve);
    await expect(tool.execute({ url: 'https://e.com' })).rejects.toThrow('fetch_http_500');
  });

  it('成功抓取超长内容时截断到上限，并回显 url', async () => {
    const fetcher = (async () =>
      new Response(`<html><body>${'a'.repeat(9000)}</body></html>`)) as unknown as typeof fetch;
    const tool = createWebFetchTool(fetcher, publicResolve);
    const out = (await tool.execute({ url: 'https://e.com/p' })) as {
      url: string;
      text: string;
      truncated: boolean;
    };
    expect(out.url).toBe('https://e.com/p');
    expect(out.text.length).toBe(8000);
    expect(out.truncated).toBe(true);
  });
});
