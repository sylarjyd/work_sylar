import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@ai-office/web-core/globals.css';

export const metadata: Metadata = {
  title: 'AI 办公智能体 · 运营平台',
  // 运营端可能被错误地暴露到公网，至少不被搜索引擎收录。
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
