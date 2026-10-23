import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { AntdProvider } from '@ai-office/web-core/antd';
import '@ai-office/web-core/globals.css';

export const metadata = { title: 'AI 办公智能体 · 智能工作台' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* AntdRegistry 在 SSR 阶段注入样式，避免首屏样式闪烁。 */}
        <AntdRegistry>
          <AntdProvider>{children}</AntdProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
