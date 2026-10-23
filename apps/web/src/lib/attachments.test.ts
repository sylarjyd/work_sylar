import { describe, it, expect } from 'vitest';
import { checkFiles, fileRejectText, formatBytes, modalityWarning, unsupportedModalities } from './attachments';

function file(name: string, content = 'x', type = 'text/plain'): File {
  return new File([content], name, { type });
}

describe('checkFiles', () => {
  it('按扩展名/MIME 分类并接受合法附件', () => {
    const { accepted, rejected } = checkFiles(
      [file('a.txt'), file('p.png', 'x', 'image/png'), file('v.mp4', 'x', 'video/mp4')],
      0,
    );
    expect(accepted.map((a) => a.kind)).toEqual(['text', 'image', 'video']);
    expect(rejected).toEqual([]);
  });

  it('拒绝不支持的类型与超限文件，其余文件仍可发送', () => {
    const huge = file('huge.txt', 'x'.repeat(10 * 1024 * 1024 + 1));
    const { accepted, rejected } = checkFiles(
      [file('evil.html', '<script>', 'text/html'), huge, file('ok.md')],
      0,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(['ok.md']);
    expect(rejected.map((r) => r.reason)).toEqual(['unsupported_type', 'file_too_large']);
  });

  it('已达数量上限时后续文件标记 too_many', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`));
    const { accepted, rejected } = checkFiles(files, 0);
    expect(accepted).toHaveLength(10);
    expect(rejected.map((r) => r.reason)).toEqual(['too_many', 'too_many']);

    // 已有 9 个待发送附件时只还能再加 1 个。
    expect(checkFiles([file('a.txt'), file('b.txt')], 9).rejected).toHaveLength(1);
  });
});

describe('模态提示', () => {
  it('只返回当前模型不支持的类别', () => {
    expect(unsupportedModalities(['text', 'image', 'image'], ['text', 'audio'])).toEqual(['image']);
    expect(unsupportedModalities(['text'], ['text', 'image'])).toEqual([]);
    // 未声明能力时不做前端拦截，交给服务端判定。
    expect(unsupportedModalities(['video'], undefined)).toEqual([]);
  });

  it('生成可读的中文提示', () => {
    expect(modalityWarning(['image', 'audio'])).toBe(
      '当前模型不支持图片、音频输入，请切换模型或移除对应附件。',
    );
  });
});

describe('formatBytes / fileRejectText', () => {
  it('按量级格式化大小', () => {
    expect(formatBytes(100)).toBe('100 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('拒绝原因带文件名', () => {
    expect(fileRejectText({ filename: 'a.html', reason: 'unsupported_type' })).toContain('a.html');
    expect(fileRejectText({ filename: 'a.txt', reason: 'file_too_large' })).toContain('超出大小上限');
  });
});
