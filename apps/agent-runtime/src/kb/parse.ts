import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

export type DocType = 'txt' | 'md' | 'csv' | 'docx' | 'xlsx' | 'pdf';

export interface ParseInput {
  data: Buffer;
  filename: string;
  mime?: string;
}

/** pdf 抽取器可注入：单测用替身，生产走 pdfjs（避免携带真实 PDF 二进制 fixture）。 */
export interface ParseDeps {
  pdf?: (data: Buffer) => Promise<string>;
}

const EXT: Record<string, DocType> = {
  txt: 'txt',
  md: 'md',
  csv: 'csv',
  // json/log 与纯文本同构：直接按 UTF-8 读取，供聊天附件复用同一抽取入口。
  json: 'txt',
  log: 'txt',
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
};

const MIME: Record<string, DocType> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf',
};

/** 按扩展名优先、mime 兜底识别类型；未识别返回 null。 */
export function detectType(filename: string, mime?: string): DocType | null {
  const dot = filename.lastIndexOf('.');
  if (dot >= 0) {
    const byExt = EXT[filename.slice(dot + 1).toLowerCase()];
    if (byExt) return byExt;
  }
  if (mime) return MIME[mime.toLowerCase()] ?? null;
  return null;
}

/**
 * 文本类附件按 BOM → 严格 UTF-8 → GBK 依次尝试。
 * 中文 Windows 上导出的 CSV/TXT 仍常是 GBK（ANSI）；直接按 UTF-8 解码会变成乱码，
 * 而 GBK 对字节序列几乎总能解码成功，所以只有在严格 UTF-8 失败时才回退。
 */
function decodeText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('gbk').decode(data);
  }
}

export async function parseDocument(input: ParseInput, deps: ParseDeps = {}): Promise<string> {
  const type = detectType(input.filename, input.mime);
  if (!type) throw new Error('unsupported_type');
  switch (type) {
    case 'txt':
    case 'md':
    case 'csv':
      return decodeText(input.data);
    case 'docx':
      return (await mammoth.extractRawText({ buffer: input.data })).value;
    case 'xlsx':
      return parseXlsx(input.data);
    case 'pdf':
      return (deps.pdf ?? parsePdf)(input.data);
  }
}

/** 逐表逐行抽文本：单元格以制表符连接、行以换行连接；日期转 ISO，富文本拼接，超链接取 text，公式取 result。 */
export async function parseXlsx(data: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // exceljs 的 d.ts 把入参声明为自带的 `Buffer`（空接口 extends ArrayBuffer），
  // 与 Node 的 Buffer 在 @types/node 22 下不兼容；运行时接受 Node Buffer，这里按参数类型收窄。
  await wb.xlsx.load(data as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const lines: string[] = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map(cellText);
      lines.push(cells.join('\t'));
    });
  });
  return lines.join('\n');
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return String(v);
  const o = v as {
    text?: unknown;
    result?: unknown;
    error?: unknown;
    richText?: { text?: unknown }[];
  };
  if (Array.isArray(o.richText)) return o.richText.map((r) => String(r.text ?? '')).join('');
  if (o.text !== undefined) return String(o.text);
  if (o.result !== undefined) return String(o.result ?? '');
  if (o.error !== undefined) return String(o.error);
  return '';
}

/** pdfjs 的 legacy build：逐页取文本项拼接（文本抽取不需要字体/画布）。 */
async function parsePdf(data: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  return parts.join('\n');
}
