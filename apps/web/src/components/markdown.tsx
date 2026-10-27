'use client';

import { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/** 高亮后代码文本被拆进多个 span，复制需要还原成纯文本。 */
function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      // 内网 HTTP 下剪贴板可能不可用；失败只改按钮文案，不打断阅读。
      await navigator.clipboard.writeText(plainText(children).replace(/\n$/, ''));
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1400);
  }

  return (
    <div className="wb-md-code">
      <button
        type="button"
        className={`wb-md-copy${state === 'failed' ? ' failed' : ''}`}
        onClick={() => void copy()}
        aria-label={
          state === 'copied' ? '代码已复制' : state === 'failed' ? '复制代码失败' : '复制代码'
        }
      >
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  a({ href, children, node: _node, ...rest }) {
    const external = typeof href === 'string' && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        {...rest}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </a>
    );
  },
  pre({ children, node: _node }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
  table({ children, node: _node }) {
    return (
      <div className="wb-md-table" tabIndex={0} role="region" aria-label="表格，可横向滚动">
        <table>{children}</table>
      </div>
    );
  },
};

/** 助手消息按 Markdown 排版；用户消息保持纯文本，避免把用户输入当格式解析。 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="wb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
