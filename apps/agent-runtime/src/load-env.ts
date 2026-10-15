import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 加载仓库根目录的 .env。
 * dev / start 都由 turbo 在各自包目录下启动（cwd = 包目录），故根 .env 位于 ../../。
 * 文件缺失时静默跳过——CI/生产由真实环境变量注入，本地则依赖 README 的 cp .env.example .env。
 */
export function loadRootEnv(): void {
  const root = resolve(process.cwd(), '../../.env');
  if (existsSync(root)) process.loadEnvFile(root);
}
