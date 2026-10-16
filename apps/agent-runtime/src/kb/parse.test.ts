import { describe, it, expect } from 'vitest';
import { detectType, parseDocument, parseXlsx } from './parse';

describe('detectType', () => {
  it('按扩展名识别（大小写不敏感）', () => {
    expect(detectType('a.txt')).toBe('txt');
    expect(detectType('A.MD')).toBe('md');
    expect(detectType('b.csv')).toBe('csv');
    expect(detectType('c.docx')).toBe('docx');
    expect(detectType('d.xlsx')).toBe('xlsx');
    expect(detectType('e.pdf')).toBe('pdf');
  });

  it('未知类型返回 null', () => {
    expect(detectType('a.exe')).toBeNull();
    expect(detectType('noext')).toBeNull();
  });
});

describe('parseDocument', () => {
  it('txt 原样返回 UTF-8 文本', async () => {
    const out = await parseDocument({ data: Buffer.from('你好\n世界', 'utf8'), filename: 'a.txt' });
    expect(out).toBe('你好\n世界');
  });

  it('csv 按文本返回', async () => {
    const out = await parseDocument({ data: Buffer.from('a,b\n1,2', 'utf8'), filename: 'a.csv' });
    expect(out).toContain('a,b');
  });

  it('docx 用 mammoth 抽出正文（真实生成 fixture）', async () => {
    const { Document, Packer, Paragraph } = await import('docx');
    const doc = new Document({ sections: [{ children: [new Paragraph('知识库里的那句话')] }] });
    const data = await Packer.toBuffer(doc);
    const out = await parseDocument({ data, filename: 'a.docx' });
    expect(out).toContain('知识库里的那句话');
  });

  it('xlsx 抽出行文本（真实生成 fixture）', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['季度', '营收']);
    ws.addRow(['Q1', 100]);
    const data = await wb.xlsx.writeBuffer();
    const out = await parseXlsx(Buffer.from(data as ArrayBuffer));
    expect(out).toContain('季度');
    expect(out).toContain('100');
  });

  it('pdf 走可注入抽取器（离线可测）', async () => {
    const out = await parseDocument(
      { data: Buffer.from('%PDF-1.4'), filename: 'a.pdf' },
      { pdf: async () => 'PDF 正文' },
    );
    expect(out).toBe('PDF 正文');
  });

  it('不支持的类型抛 unsupported_type', async () => {
    await expect(parseDocument({ data: Buffer.from('x'), filename: 'a.exe' })).rejects.toThrow(
      'unsupported_type',
    );
  });
});
