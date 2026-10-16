import { describe, it, expect } from 'vitest';
import { createDocTools, artifactKey, safeFilename } from './doc';
import type { Storage } from '../storage/s3';
import type { RunContext } from './types';

const ctx: RunContext = { tenantId: 't1', sessionId: 's1', runId: 'r1' };

function fakeStorage(captured: { key: string; body: Buffer; contentType: string }[]): Storage {
  return {
    ensureBucket: async () => {},
    putObject: async (key, body, contentType) => {
      captured.push({ key, body, contentType });
    },
    getObjectStream: async () => {
      throw new Error('unused');
    },
  };
}

describe('artifactKey / safeFilename', () => {
  it('按 artifacts/{tenantId}/{runId}/{uuid}-{filename} 拼 Key', () => {
    const key = artifactKey(ctx, '报告.pptx');
    expect(key).toMatch(/^artifacts\/t1\/r1\/[0-9a-f-]{36}-报告\.pptx$/);
  });

  it('清洗路径穿越字符，避免越出租户前缀', () => {
    expect(safeFilename('../../etc/passwd')).not.toContain('..');
    expect(safeFilename('../../etc/passwd')).not.toContain('/');
    const key = artifactKey(ctx, '../../etc/passwd');
    expect(key.startsWith('artifacts/t1/r1/')).toBe(true);
    expect(key).not.toContain('..');
  });
});

describe('createDocTools', () => {
  it('暴露 doc.docx / doc.xlsx / doc.pptx 三个工具', () => {
    const tools = createDocTools(fakeStorage([]));
    expect(tools.map((t) => t.name)).toEqual(['doc.docx', 'doc.xlsx', 'doc.pptx']);
  });

  it('doc.pptx 生成、上传并返回 ArtifactRef', async () => {
    const captured: { key: string; body: Buffer; contentType: string }[] = [];
    const tools = createDocTools(fakeStorage(captured));
    const pptx = tools.find((t) => t.name === 'doc.pptx')!;
    const out = (await pptx.execute(
      { filename: '报告.pptx', slides: [{ title: '封面', bullets: ['要点'] }] },
      ctx,
    )) as { artifact: Record<string, unknown> };
    expect(out.artifact).toMatchObject({ kind: 'pptx', filename: '报告.pptx' });
    expect(String(out.artifact.storageKey)).toMatch(/^artifacts\/t1\/r1\/.+-报告\.pptx$/);
    expect(Number(out.artifact.size)).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].contentType).toContain('presentationml');
    expect(captured[0].body.length).toBeGreaterThan(0);
  });

  it('doc.docx 缺 filename 抛错（交由 agent-loop 记为工具失败）', async () => {
    const docx = createDocTools(fakeStorage([])).find((t) => t.name === 'doc.docx')!;
    await expect(docx.execute({ sections: [] }, ctx)).rejects.toThrow('missing_filename');
  });

  it('doc.xlsx 生成并上传', async () => {
    const captured: { key: string; body: Buffer; contentType: string }[] = [];
    const xlsx = createDocTools(fakeStorage(captured)).find((t) => t.name === 'doc.xlsx')!;
    const out = (await xlsx.execute(
      { filename: '表.xlsx', sheets: [{ name: 'S1', rows: [['a', 1]] }] },
      ctx,
    )) as { artifact: Record<string, unknown> };
    expect(out.artifact).toMatchObject({ kind: 'xlsx', filename: '表.xlsx' });
    expect(captured[0].contentType).toContain('spreadsheetml');
  });
});
