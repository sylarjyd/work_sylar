import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './filename';

describe('sanitizeFilename', () => {
  it('剥离目录成分（防路径逃逸）', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a\\b\\c.txt')).toBe('c.txt');
  });

  it('替换危险字符，保留中文与扩展名', () => {
    expect(sanitizeFilename('报告:2024?.docx')).toBe('报告_2024_.docx');
  });

  it('空名与纯点名回退 fallback', () => {
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('a/b/')).toBe('file');
    expect(sanitizeFilename('a/b')).toBe('b');
  });
});
