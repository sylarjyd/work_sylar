import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import ExcelJS from 'exceljs';
import { buildDocx, buildXlsx, buildPptx } from './doc-generators';

describe('buildDocx', () => {
  it('产出合法 docx 且含标题/小标题/段落文本', async () => {
    const buf = await buildDocx({
      title: '季度报告',
      sections: [{ heading: '概述', paragraphs: ['第一段'] }],
    });
    // docx 本质是 zip：解出 document.xml 断言文本确实写进去了（而非仅非空）。
    const files = unzipSync(new Uint8Array(buf));
    const xml = strFromU8(files['word/document.xml']);
    expect(xml).toContain('季度报告');
    expect(xml).toContain('概述');
    expect(xml).toContain('第一段');
  });
});

describe('buildXlsx', () => {
  it('产出的表格可被 exceljs 反解，表头与数据行正确', async () => {
    const buf = await buildXlsx({
      sheets: [{ name: 'S1', rows: [['名称', '数量'], ['A', 3]] }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('S1');
    expect(ws?.getCell('A1').value).toBe('名称');
    expect(ws?.getCell('B1').value).toBe('数量');
    expect(ws?.getCell('A2').value).toBe('A');
    expect(ws?.getCell('B2').value).toBe(3);
  });
});

describe('buildPptx', () => {
  it('产出合法 pptx 且首页含标题与要点文本', async () => {
    const buf = await buildPptx({ slides: [{ title: '封面', bullets: ['要点一'] }] });
    const files = unzipSync(new Uint8Array(buf));
    const xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('封面');
    expect(xml).toContain('要点一');
  });
});
