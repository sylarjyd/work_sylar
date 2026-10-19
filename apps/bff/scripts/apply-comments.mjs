import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

// Prisma CLI 与脚本都不会自动加载仓库根目录的 .env，这里显式补上；
// 已存在的环境变量优先，便于部署时用外部配置覆盖。
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const sql = readFileSync(resolve(process.cwd(), 'prisma/comments.sql'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const prisma = new PrismaClient();
try {
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
  console.log(`已应用 ${statements.length} 条中文注释`);
} finally {
  await prisma.$disconnect();
}
