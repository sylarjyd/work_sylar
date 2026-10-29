import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const prisma = new PrismaClient();

const SKILLS = [
  {
    slug: 'weekly-report',
    name: '周报撰写规范',
    description: '按“完成项 / 风险 / 下周计划”三段式写周报，先事实后判断',
    content: [
      '适用场景：用户要求写周报、双周报或工作汇报时。',
      '结构：1) 本周完成：按项目列事实与结果，能带数字就带数字；2) 风险与阻塞：写清影响面与需要的支持；3) 下周计划：按优先级列 3-5 项。',
      '要求：不写空话套话，不夸大；不确定的数据标注“待确认”；每段控制在 5 行以内。',
    ].join('\n'),
  },
  {
    slug: 'meeting-notes',
    name: '会议纪要整理',
    description: '把会议记录整理成结论、待办与责任人',
    content: [
      '适用场景：用户粘贴会议记录或录音转写，要求整理纪要时。',
      '结构：1) 会议主题与结论；2) 关键讨论点（每人一句）；3) 待办清单：事项 / 责任人 / 截止时间；4) 待确认问题。',
      '要求：只记录事实与明确结论，不替与会者做决定；缺失的责任人写“待指派”。',
    ].join('\n'),
  },
  {
    slug: 'data-analysis-chart',
    name: '数据分析与图表',
    description: '先核对口径与总数，再用图表呈现关键对比',
    content: [
      '适用场景：用户提供数据表或要求分析经营/运营数据时。',
      '步骤：1) 先说明数据口径与缺失值；2) 计算关键指标并交叉验证总数；3) 用 chart.render 画 1-2 张图（趋势用折线、对比用柱状、占比用饼图）；4) 给出 3 条以内可执行结论。',
      '要求：结论必须能被图中数据支撑；样本过小或口径不一致时先提示风险。',
    ].join('\n'),
  },
];

const ASSISTANTS = [
  {
    name: '周报助手',
    description: '按公司规范把一周工作整理成周报',
    systemPrompt: '你是周报助手。先向用户确认本周主要事项，再按技能里的结构输出周报；语气简洁、只写事实。',
    skills: ['docs'],
    skillSlug: 'weekly-report',
  },
  {
    name: '会议纪要助手',
    description: '把会议记录整理成结论与待办',
    systemPrompt: '你是会议纪要助手。用户提供会议记录后，按技能结构输出纪要，待办必须带责任人与截止时间。',
    skills: ['docs'],
    skillSlug: 'meeting-notes',
  },
  {
    name: '数据分析助手',
    description: '核对数据口径并输出图表与结论',
    systemPrompt: '你是数据分析助手。先确认数据口径，再用图表呈现关键对比，最后给出可执行结论。',
    skills: ['docs', 'web'],
    skillSlug: 'data-analysis-chart',
  },
  {
    name: '知识库问答助手',
    description: '只基于企业知识库回答，不编造',
    systemPrompt: '你是知识库问答助手。优先检索知识库，回答时标注来源文档；知识库没有依据时明确说“资料中没有”。',
    skills: ['kb'],
    skillSlug: null,
  },
];

try {
  // 内置公共资源挂在运营账号下：tenantId/userId 仍非空，便于统一审计。
  const admin = await prisma.user.findFirst({
    where: { role: 'admin' },
    select: { id: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) throw new Error('没有 admin 账号，无法挂载内置助手');

  const skillIdBySlug = new Map();
  for (const skill of SKILLS) {
    const existing = await prisma.skill.findFirst({
      where: { scope: 'public', slug: skill.slug },
      select: { id: true },
    });
    if (existing) {
      await prisma.skill.update({
        where: { id: existing.id },
        data: {
          name: skill.name,
          description: skill.description,
          content: skill.content,
          enabled: true,
          source: 'manual',
        },
      });
      skillIdBySlug.set(skill.slug, existing.id);
    } else {
      const created = await prisma.skill.create({
        data: {
          scope: 'public',
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          source: 'manual',
          enabled: true,
        },
        select: { id: true },
      });
      skillIdBySlug.set(skill.slug, created.id);
    }
  }

  for (const assistant of ASSISTANTS) {
    const skillIds = assistant.skillSlug ? [skillIdBySlug.get(assistant.skillSlug)] : [];
    const existing = await prisma.assistant.findUnique({
      where: {
        tenantId_userId_name: { tenantId: admin.tenantId, userId: admin.id, name: assistant.name },
      },
      select: { id: true },
    });
    const data = {
      scope: 'public',
      description: assistant.description,
      systemPrompt: assistant.systemPrompt,
      skills: assistant.skills,
      skillIds,
      permissionMode: 'standard',
    };
    if (existing) {
      await prisma.assistant.update({ where: { id: existing.id }, data });
    } else {
      await prisma.assistant.create({
        data: { tenantId: admin.tenantId, userId: admin.id, name: assistant.name, ...data },
      });
    }
  }

  const [skills, assistants] = await Promise.all([
    prisma.skill.count({ where: { scope: 'public' } }),
    prisma.assistant.count({ where: { scope: 'public' } }),
  ]);
  console.log(`内置技能 ${skills} 个，公共助手 ${assistants} 个`);
} finally {
  await prisma.$disconnect();
}
