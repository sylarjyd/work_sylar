import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 组件测试要走 React 17+ 的自动 jsx 运行时；tsconfig 为 Next 保留了 jsx: preserve。
  esbuild: { jsx: 'automatic' },
});
