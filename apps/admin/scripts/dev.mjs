import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 管理端开发启动器：先起 next dev，再在后台把全部菜单路由预编译一遍。
 * Next 开发模式是按路由懒编译的，首次点菜单要等 2-12s；预热后切页只剩 100-400ms。
 */
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3001;
const ROUTES = [
  '/overview',
  '/users',
  '/tenants',
  '/plans',
  '/sessions',
  '/assistants',
  '/tasks',
  '/kb',
  '/skills',
  '/models',
  '/settings',
  '/qa-cache',
  '/audit',
];

const nextBin = resolve(appDir, 'node_modules/next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(PORT)], {
  cwd: appDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

async function waitReady() {
  for (let i = 0; i < 180; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/login`);
      if (res.ok) return true;
    } catch {
      // 还没监听，继续等。
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function warm() {
  if (!(await waitReady())) return;
  console.log('[dev] 开发服务器已就绪，开始预热路由…');
  for (const route of ROUTES) {
    const started = Date.now();
    try {
      await fetch(`http://127.0.0.1:${PORT}${route}`, { redirect: 'manual' });
      console.log(`[dev] 预热 ${route} ${Date.now() - started}ms`);
    } catch {
      // 单个路由预热失败不影响开发服务器。
    }
  }
  console.log('[dev] 路由预热完成，菜单切换不再等待编译。');
}

void warm();
