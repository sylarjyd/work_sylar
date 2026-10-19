// 运维脚本：把已注册账号提升为管理员。
// 注册接口不再授予 admin，避免白名单邮箱被抢注后直接提权。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;
const email = (process.argv[2] ?? '').trim().toLowerCase();

if (!email) {
  console.error('用法: pnpm --filter @ai-office/bff admin:promote <email>');
  process.exit(1);
}

const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error(`未找到账号 ${email}，请先完成注册再执行本脚本`);
    process.exitCode = 1;
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { role: 'admin' } });
    console.log(`已将 ${user.email} 提升为管理员`);
  }
} finally {
  await prisma.$disconnect();
}
