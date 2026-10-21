import type { ReactNode } from 'react';
import '@ai-office/web-core/globals.css';

export const metadata = { title: 'AI 办公智能体 · 智能工作台' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
