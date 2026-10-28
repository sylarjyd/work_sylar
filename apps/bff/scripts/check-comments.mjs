import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

// 与 apply-comments.mjs 一致：Prisma 脚本不自动读根 .env，这里显式补上。
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function commentStatements(text) {
  return new Set(
    text
      .split('\n')
      .filter((line) => line.trim().startsWith('COMMENT ON '))
      .map((line) => line.trim().replace(/\s+/g, ' ')),
  );
}

const prisma = new PrismaClient();
let failed = false;
try {
  // 排除 Prisma 迁移表（_prisma_migrations），业务表都要有表级与字段级注释。
  const tables = await prisma.$queryRawUnsafe(
    `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
     FROM pg_class c
     WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relname NOT LIKE '\\_%'
     ORDER BY 1`,
  );
  const columns = await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tbl, a.attname AS col, col_description(c.oid, a.attnum) AS comment
     FROM pg_class c
     JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relname NOT LIKE '\\_%'
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1, a.attnum`,
  );

  const missingTables = tables.filter((t) => !t.comment).map((t) => t.name);
  const missingColumns = columns.filter((c) => !c.comment).map((c) => `${c.tbl}.${c.col}`);

  if (missingTables.length + missingColumns.length === 0) {
    console.log(`中文注释完整：${tables.length} 张表、${columns.length} 个字段`);
  } else {
    failed = true;
    console.error(`缺少中文注释：${missingTables.length} 张表、${missingColumns.length} 个字段`);
    for (const name of missingTables) console.error(`  表  ${name}`);
    for (const name of missingColumns) console.error(`  字段 ${name}`);
    console.error('请在 prisma/comments.sql 补齐后重新执行 db:comments。');
  }
} finally {
  await prisma.$disconnect();
}

// schema.sql 是可直接建库的基线，必须带上同一份注释；两处不一致时提示重新生成。
const source = commentStatements(readFileSync(resolve(process.cwd(), 'prisma/comments.sql'), 'utf8'));
const baseline = commentStatements(
  readFileSync(resolve(process.cwd(), '../../docs/db/schema.sql'), 'utf8'),
);
const absentInBaseline = [...source].filter((line) => !baseline.has(line));
const extraInBaseline = [...baseline].filter((line) => !source.has(line));
if (absentInBaseline.length + extraInBaseline.length > 0) {
  failed = true;
  console.error(
    `comments.sql 与 docs/db/schema.sql 注释不一致：基线缺 ${absentInBaseline.length} 条，多 ${extraInBaseline.length} 条`,
  );
  for (const line of absentInBaseline.slice(0, 10)) console.error(`  基线缺 ${line}`);
  for (const line of extraInBaseline.slice(0, 10)) console.error(`  基线多 ${line}`);
  console.error('请按 schema.sql 文件头的步骤重新生成基线。');
}

if (failed) process.exitCode = 1;
