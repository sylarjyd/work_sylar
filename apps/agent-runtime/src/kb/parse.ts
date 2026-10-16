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
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
};

const MIME: Record<string, DocType> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
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

export async function parseDocument(input: ParseInput, deps: ParseDeps = {}): Promise<string> {
  const type = detectType(input.filename, input.mime);
  if (!type) throw new Error('unsupported_type');
  switch (type) {
    case 'txt':
    case 'md':
    case 'csv':
      return input.data.toString('utf8').replace(/^\uFEFF/, '');
    case 'docx':
      return (await mammoth.extractRawText({ buffer: input.data })).value;
    case 'xlsx':
      return parseXlsx(input.data);
    case 'pdf':
      return (deps.pdf ?? parsePdf)(input.data);
  }
}

/** 逐表逐行抽文本，单元格以制表符连接；公式取 result，富文本取 text。 */
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
  if (typeof v !== 'object') return String(v);
  const o = v as { text?: unknown; result?: unknown };
  if (o.text !== undefined) return String(o.text);
  if (o.result !== undefined) return String(o.result ?? '');
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
