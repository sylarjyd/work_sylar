// 容器启动前置检查：轮询 HTTP 端点直到就绪或超时。
// 用于 runtime 等待 MinIO（桶创建在启动时执行，MinIO 未就绪会直接失败且不重试）。
// 用法：node wait-for-http.mjs <url> [timeoutMs]

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 60000);
if (!url) {
  console.error('用法: node wait-for-http.mjs <url> [timeoutMs]');
  process.exit(2);
}

const deadline = Date.now() + timeoutMs;
for (;;) {
  try {
    const res = await fetch(url);
    if (res.ok) process.exit(0);
  } catch {
    // 连接失败是预期状态，继续重试。
  }
  if (Date.now() > deadline) {
    console.error(`wait-for-http: ${url} 未在 ${timeoutMs}ms 内就绪`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
