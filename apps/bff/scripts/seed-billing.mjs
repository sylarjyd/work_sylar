import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

// 与 apply-comments.mjs 一致：Prisma 脚本不自动读根 .env，这里显式补上。
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const plans = [
  {
    id: 'free',
    name: '体验版',
    priceCents: 0,
    monthlyBaseCredits: 500,
    monthlyBonusCredits: 0,
    maxCreditsPerRun: 50,
    rpm: 10,
    allowedModels: ['deepseek-chat'],
    active: true,
  },
  {
    id: 'standard',
    name: '标准版',
    priceCents: 9900,
    monthlyBaseCredits: 2000,
    monthlyBonusCredits: 2000,
    maxCreditsPerRun: 200,
    rpm: 30,
    allowedModels: ['deepseek-chat', 'deepseek-reasoner'],
    active: true,
  },
  {
    id: 'premium',
    name: '高级版',
    priceCents: 19900,
    monthlyBaseCredits: 4000,
    monthlyBonusCredits: 5000,
    maxCreditsPerRun: 500,
    rpm: 60,
    allowedModels: ['deepseek-chat', 'deepseek-reasoner'],
    active: true,
  },
  {
    id: 'ultimate',
    name: '旗舰版',
    priceCents: 99900,
    monthlyBaseCredits: 20000,
    monthlyBonusCredits: 30000,
    maxCreditsPerRun: 2000,
    rpm: 120,
    allowedModels: ['deepseek-chat', 'deepseek-reasoner'],
    active: true,
  },
];

const prices = [
  { model: 'deepseek-chat', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
  { model: 'deepseek-reasoner', inputMilliCreditsPer1k: 200, outputMilliCreditsPer1k: 800 },
  { model: 'mock', inputMilliCreditsPer1k: 100, outputMilliCreditsPer1k: 300 },
];

const prisma = new PrismaClient();
try {
  for (const plan of plans) {
    await prisma.plan.upsert({ where: { id: plan.id }, create: plan, update: plan });
  }
  for (const price of prices) {
    await prisma.modelPrice.upsert({ where: { model: price.model }, create: price, update: price });
  }
  console.log(`已写入 ${plans.length} 个套餐、${prices.length} 条模型价格`);
} finally {
  await prisma.$disconnect();
}
