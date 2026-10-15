import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest 默认用 esbuild 转译，而 esbuild（含最新版）不产出 design:paramtypes
  // 元数据，NestJS 的构造函数注入会拿到 undefined。改用 SWC：它会读取 tsconfig 的
  // emitDecoratorMetadata 来产出元数据，DI 才能工作。
  plugins: [
    swc.vite({
      // 显式固定模块类型，避免被 .swcrc 之类的配置影响。
      module: { type: 'es6' },
    }),
  ],
});
