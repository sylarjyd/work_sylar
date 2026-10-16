import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';

export interface DocxInput {
  title?: string;
  sections: { heading?: string; paragraphs: string[] }[];
}

export interface XlsxInput {
  sheets: { name: string; rows: (string | number)[][] }[];
}

export interface PptxInput {
  slides: { title?: string; bullets: string[] }[];
}

export async function buildDocx(input: DocxInput): Promise<Buffer> {
  const children: Paragraph[] = [];
  if (input.title) {
    children.push(new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }));
  }
  for (const section of input.sections) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const text of section.paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildXlsx(input: XlsxInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of input.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildPptx(input: PptxInput): Promise<Buffer> {
  const pptx = new PptxGenJS();
  for (const s of input.slides) {
    const slide = pptx.addSlide();
    if (s.title) {
      slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 24, bold: true });
    }
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
      { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 16 },
    );
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return out;
}
