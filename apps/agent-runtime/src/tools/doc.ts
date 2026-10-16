import { randomUUID } from 'node:crypto';
import type { ArtifactKind, ArtifactRef } from '@ai-office/shared';
import type { Storage } from '../storage/s3';
import type { RunContext, Tool } from './types';
import { buildDocx, buildXlsx, buildPptx } from './doc-generators';

const MIME: Record<ArtifactKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 去掉控制字符（含 CR/LF，防止注入 HTTP 头）与路径分隔符 / `..`，防止模型给的 filename 越出 `artifacts/{tenantId}/{runId}/` 前缀。 */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\.\./g, '_')
    .trim();
  return cleaned || 'artifact';
}

export function artifactKey(ctx: Pick<RunContext, 'tenantId' | 'runId'>, filename: string): string {
  return `artifacts/${ctx.tenantId}/${ctx.runId}/${randomUUID()}-${safeFilename(filename)}`;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`missing_${key}`);
  return v;
}

async function emit(
  storage: Storage,
  ctx: RunContext,
  kind: ArtifactKind,
  filename: string,
  bytes: Buffer,
): Promise<{ artifact: ArtifactRef }> {
  const clean = safeFilename(filename);
  const storageKey = artifactKey(ctx, clean);
  await storage.putObject(storageKey, bytes, MIME[kind]);
  return { artifact: { kind, filename: clean, storageKey, size: bytes.length } };
}

export function createDocTools(storage: Storage): Tool[] {
  return [
    {
      name: 'doc.docx',
      description: '生成 Word 文档（.docx），返回产出物引用。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，如 报告.docx' },
          title: { type: 'string', description: '文档标题（可选）' },
          sections: {
            type: 'array',
            description: '章节列表',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['filename', 'sections'],
      },
      permission: 'safe',
      async execute(args, ctx) {
        const filename = str(args, 'filename');
        const sections = args.sections;
        if (!Array.isArray(sections)) throw new Error('missing_sections');
        const bytes = await buildDocx({
          title: typeof args.title === 'string' ? args.title : undefined,
          sections: sections as { heading?: string; paragraphs: string[] }[],
        });
        return emit(storage, ctx, 'docx', filename, bytes);
      },
    },
    {
      name: 'doc.xlsx',
      description: '生成 Excel 表格（.xlsx），返回产出物引用。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，如 数据.xlsx' },
          sheets: {
            type: 'array',
            description: '工作表列表',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array' } },
              },
              required: ['name', 'rows'],
            },
          },
        },
        required: ['filename', 'sheets'],
      },
      permission: 'safe',
      async execute(args, ctx) {
        const filename = str(args, 'filename');
        const sheets = args.sheets;
        if (!Array.isArray(sheets)) throw new Error('missing_sheets');
        const bytes = await buildXlsx({ sheets: sheets as { name: string; rows: (string | number)[][] }[] });
        return emit(storage, ctx, 'xlsx', filename, bytes);
      },
    },
    {
      name: 'doc.pptx',
      description: '生成 PowerPoint 演示文稿（.pptx），返回产出物引用。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，如 汇报.pptx' },
          slides: {
            type: 'array',
            description: '幻灯片列表',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['filename', 'slides'],
      },
      permission: 'safe',
      async execute(args, ctx) {
        const filename = str(args, 'filename');
        const slides = args.slides;
        if (!Array.isArray(slides)) throw new Error('missing_slides');
        const bytes = await buildPptx({ slides: slides as { title?: string; bullets: string[] }[] });
        return emit(storage, ctx, 'pptx', filename, bytes);
      },
    },
  ];
}
