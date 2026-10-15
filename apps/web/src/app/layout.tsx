import type { ReactNode } from 'react';

export const metadata = { title: 'AI 办公智能体' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 24 }}>{children}</body>
    </html>
  );
}
