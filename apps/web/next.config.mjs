/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ai-office/shared'],
  // 关闭开发期的 Next.js 调试浮层，避免界面出现英文控件。
  devIndicators: false,
};

export default nextConfig;
