import { describe, it, expect } from 'vitest';
import { createFileTools, isTextFilename } from './file-write';
import type { Storage } from '../storage/s3';
import type { RunContext } from './types';

const ctx: RunContext = { tenantId: 't1', userId: 'u1', sessionId: 's1', runId: 'r1' };

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

describe('isTextFilename', () => {
  it('接受常见代码与纯文本扩展名（大小写不敏感）', () => {
    for (const name of ['A.java', 'main.ts', 'x.YML', 'data.csv', 'README.md', 'q.sql']) {
      expect(isTextFilename(name)).toBe(true);
    }
  });

  it('拒绝二进制、可执行与无扩展名文件', () => {
    for (const name of ['a.exe', 'a.docx', 'a.bin', 'Makefile', 'a.']) {
      expect(isTextFilename(name)).toBe(false);
    }
  });
});

describe('createFileTools', () => {
  it('file.write 保存文本并返回 kind=text 的 ArtifactRef', async () => {
    const captured: { key: string; body: Buffer; contentType: string }[] = [];
    const tool = createFileTools(fakeStorage(captured))[0];
    const out = (await tool.execute(
      { filename: 'UploadController.java', content: 'class A {}' },
      ctx,
    )) as { artifact: Record<string, unknown> };

    expect(out.artifact).toMatchObject({ kind: 'text', filename: 'UploadController.java' });
    expect(String(out.artifact.storageKey)).toMatch(
      /^artifacts\/t1\/r1\/[0-9a-f-]{36}-UploadController\.java$/,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].contentType).toBe('text/plain; charset=utf-8');
    expect(captured[0].body.toString('utf8')).toBe('class A {}');
    expect(out.artifact.size).toBe(Buffer.byteLength('class A {}'));
  });

  it('缺少文件名或内容时抛错（交由 agent-loop 记为工具失败）', async () => {
    const tool = createFileTools(fakeStorage([]))[0];
    await expect(tool.execute({ content: 'x' }, ctx)).rejects.toThrow('missing_filename');
    await expect(tool.execute({ filename: 'a.md', content: '  ' }, ctx)).rejects.toThrow(
      'missing_content',
    );
  });

  it('拒绝非文本扩展名，避免把二进制落成成果', async () => {
    const tool = createFileTools(fakeStorage([]))[0];
    await expect(tool.execute({ filename: 'a.exe', content: 'MZ' }, ctx)).rejects.toThrow(
      'unsupported_file_type',
    );
  });

  it('文件名清洗后仍保留扩展名，防止路径穿越', async () => {
    const tool = createFileTools(fakeStorage([]))[0];
    const out = (await tool.execute(
      { filename: '../../evil\r\nX: y.java', content: 'class E {}' },
      ctx,
    )) as { artifact: { filename: string } };
    expect(out.artifact.filename).not.toContain('..');
    expect(out.artifact.filename).not.toContain('/');
    expect(out.artifact.filename).not.toMatch(/[\r\n]/);
  });
});
