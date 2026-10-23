// 知识库数据回填：把平铺的 KbDoc 归入每用户「默认知识库」，并把助手的文档级绑定
// 转成知识库级绑定。脚本幂等，可在每次启动时执行；--check 只校验不写入。
import { fileURLToPath } from 'node:url';

export const DEFAULT_KB_NAME = '默认知识库';
const DEFAULT_KB_DESCRIPTION = '存量文档自动归集';

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ logger?: Pick<Console, 'info' | 'warn' | 'error'> }} [options]
 */
export async function backfillKb(prisma, { logger = console } = {}) {
  const basesCreated = await assignOrphanDocs(prisma, logger);
  const { assistantsConverted, assistantsFallback } = await convertAssistantBindings(prisma, logger);
  const summary = {
    basesCreated,
    assistantsConverted,
    assistantsFallback,
    ...(await verifyKbBackfill(prisma)),
  };
  assertVerified(summary);
  logger.info(
    `知识库回填完成：新建/复用库 ${basesCreated} 个，转换助手 ${assistantsConverted} 个` +
      `（兜底绑定默认库 ${assistantsFallback} 个），剩余未归类文档 ${summary.remainingDocs}，` +
      `剩余旧绑定助手 ${summary.remainingAssistants}`,
  );
  return summary;
}

/**
 * 每个 (tenant,user) 的存量文档归入默认知识库；已归类的文档不动。
 * 返回本次创建的知识库数量（复用的不计）。
 */
async function assignOrphanDocs(prisma, logger) {
  const groups = await prisma.kbDoc.groupBy({
    by: ['tenantId', 'userId'],
    where: { knowledgeBaseId: null },
  });
  let created = 0;
  for (const { tenantId, userId } of groups) {
    const existing = await prisma.knowledgeBase.findUnique({
      where: { tenantId_userId_name: { tenantId, userId, name: DEFAULT_KB_NAME } },
      select: { id: true },
    });
    const base =
      existing ??
      (await prisma.knowledgeBase.create({
        data: {
          tenantId,
          userId,
          name: DEFAULT_KB_NAME,
          description: DEFAULT_KB_DESCRIPTION,
        },
        select: { id: true },
      }));
    if (!existing) created += 1;

    const { count } = await prisma.kbDoc.updateMany({
      where: { tenantId, userId, knowledgeBaseId: null },
      data: { knowledgeBaseId: base.id },
    });
    logger.info(`用户 ${tenantId}/${userId}：${count} 篇文档归入知识库 ${base.id}`);
  }
  return created;
}

/**
 * 旧助手 kbDocIds → kbIds：
 * - 取旧文档所属知识库去重；
 * - 旧文档全部丢失时绑定该用户默认知识库，避免空数组被当成“全部知识库”扩大范围；
 * - 处理完清空 kbDocIds，保证重跑无动作。
 */
async function convertAssistantBindings(prisma, logger) {
  const assistants = await prisma.assistant.findMany({
    where: { kbDocIds: { isEmpty: false } },
    select: { id: true, tenantId: true, userId: true, kbIds: true, kbDocIds: true },
  });
  let converted = 0;
  let fallback = 0;
  for (const assistant of assistants) {
    const docs = await prisma.kbDoc.findMany({
      where: {
        id: { in: assistant.kbDocIds },
        tenantId: assistant.tenantId,
        userId: assistant.userId,
      },
      select: { knowledgeBaseId: true },
    });
    const mapped = [...new Set(docs.map((d) => d.knowledgeBaseId).filter(Boolean))];
    const next = [...new Set([...(assistant.kbIds ?? []), ...mapped])];
    if (next.length === 0) {
      const defaultBase = await prisma.knowledgeBase.findUnique({
        where: {
          tenantId_userId_name: {
            tenantId: assistant.tenantId,
            userId: assistant.userId,
            name: DEFAULT_KB_NAME,
          },
        },
        select: { id: true },
      });
      if (defaultBase) {
        next.push(defaultBase.id);
        fallback += 1;
      } else {
        // 没有任何可绑定的知识库：保留空数组（该用户没有文档，空即“全部”无实际放大）。
        logger.warn(`assistant_legacy_binding_lost: ${assistant.id} 的旧文档已不存在`);
      }
    }
    await prisma.assistant.update({
      where: { id: assistant.id },
      data: { kbIds: next, kbDocIds: [] },
    });
    converted += 1;
  }
  return { assistantsConverted: converted, assistantsFallback: fallback };
}

/** 只读校验，返回剩余异常计数；供 --check 与回填后自检共用。 */
export async function verifyKbBackfill(prisma) {
  const [remainingDocs, remainingAssistants, mismatchedDocs] = await Promise.all([
    prisma.kbDoc.count({ where: { knowledgeBaseId: null } }),
    prisma.assistant.count({ where: { kbDocIds: { isEmpty: false } } }),
    prisma.$queryRaw`
      SELECT count(*)::int AS "count"
      FROM "KbDoc" d JOIN "KnowledgeBase" b ON b.id = d."knowledgeBaseId"
      WHERE d."tenantId" <> b."tenantId" OR d."userId" <> b."userId"
    `,
  ]);
  return {
    remainingDocs,
    remainingAssistants,
    mismatchedDocs: Number(mismatchedDocs?.[0]?.count ?? 0),
  };
}

function assertVerified(summary) {
  const problems = [];
  if (summary.remainingDocs !== 0) problems.push(`${summary.remainingDocs} 篇文档未归类`);
  if (summary.remainingAssistants !== 0) problems.push(`${summary.remainingAssistants} 个助手仍保留旧绑定`);
  if (summary.mismatchedDocs !== 0) problems.push(`${summary.mismatchedDocs} 篇文档与知识库归属不一致`);
  if (problems.length > 0) throw new Error(`知识库回填校验失败：${problems.join('；')}`);
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    if (checkOnly) {
      const summary = await verifyKbBackfill(prisma);
      assertVerified(summary);
      console.info('知识库回填校验通过', summary);
      return;
    }
    await backfillKb(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// 仅作为脚本直接执行时跑 main；被测试 import 时不触发。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
