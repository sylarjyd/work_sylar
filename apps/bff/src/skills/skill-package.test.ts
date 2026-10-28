import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  parseSkillPackage,
  readSkillPackageFile,
  SkillPackageError,
} from './skill-package';

function zip(entries: Record<string, string>): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(entries)) files[path] = strToU8(content);
  return Buffer.from(zipSync(files));
}

const SKILL_MD = `---
name: weekly-report
description: 按公司模板写周报
version: 1.2.0
license: MIT
allowed-tools: Read Write
---

# 周报写法

1. 先列本周完成项
2. 再列风险
`;

describe('parseSkillPackage', () => {
  it('解析根目录 SKILL.md 并列出附带资源', () => {
    const buffer = zip({
      'SKILL.md': SKILL_MD,
      'references/template.md': '# 模板',
      'scripts/build.py': 'print(1)',
    });
    const parsed = parseSkillPackage(buffer);
    expect(parsed.meta).toMatchObject({
      name: 'weekly-report',
      slug: 'weekly-report',
      description: '按公司模板写周报',
      version: '1.2.0',
      license: 'MIT',
      allowedTools: ['Read', 'Write'],
    });
    expect(parsed.meta.content).toContain('# 周报写法');
    expect(parsed.files.map((file) => file.path).sort()).toEqual([
      'references/template.md',
      'scripts/build.py',
    ]);
    expect(parsed.totalBytes).toBeGreaterThan(0);
  });

  it('支持压缩时带一层目录，清单路径去掉前缀', () => {
    const buffer = zip({
      'weekly-report/SKILL.md': SKILL_MD,
      'weekly-report/references/template.md': '# 模板',
    });
    const parsed = parseSkillPackage(buffer);
    expect(parsed.meta.slug).toBe('weekly-report');
    expect(parsed.files).toEqual([
      expect.objectContaining({ path: 'references/template.md' }),
    ]);
  });

  it('缺少 SKILL.md、缺 description、name 非规范都给出明确错误码', () => {
    expect(() => parseSkillPackage(zip({ 'README.md': 'x' }))).toThrowError(
      expect.objectContaining({ code: 'skill_md_missing' }),
    );
    expect(() =>
      parseSkillPackage(zip({ 'SKILL.md': '---\nname: ok\n---\n正文' })),
    ).toThrowError(expect.objectContaining({ code: 'description_required' }));
    expect(() =>
      parseSkillPackage(
        zip({ 'SKILL.md': '---\nname: Bad_Name\ndescription: x\n---\n正文' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_name' }));
  });

  it('frontmatter 缺失或 YAML 非法时报错，不猜测字段', () => {
    expect(() => parseSkillPackage(zip({ 'SKILL.md': '# 没有 frontmatter' }))).toThrowError(
      expect.objectContaining({ code: 'frontmatter_missing' }),
    );
    expect(() =>
      parseSkillPackage(zip({ 'SKILL.md': '---\nname: [unclosed\n---\n正文' })),
    ).toThrowError(expect.objectContaining({ code: 'frontmatter_invalid' }));
  });

  it('拒绝目录穿越与非 zip 内容', () => {
    expect(() =>
      parseSkillPackage(zip({ 'SKILL.md': SKILL_MD, '../evil.txt': 'x' })),
    ).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
    expect(() => parseSkillPackage(Buffer.from('not a zip'))).toThrowError(
      expect.objectContaining({ code: 'invalid_zip' }),
    );
  });

  it('readSkillPackageFile 按相对路径读取，非法路径返回 null', () => {
    const buffer = zip({
      'weekly-report/SKILL.md': SKILL_MD,
      'weekly-report/references/template.md': '# 模板',
    });
    expect(readSkillPackageFile(buffer, 'references/template.md')?.byteLength).toBeGreaterThan(0);
    expect(readSkillPackageFile(buffer, '../SKILL.md')).toBeNull();
    expect(readSkillPackageFile(buffer, 'references/missing.md')).toBeNull();
  });

  it('SkillPackageError 带稳定错误码', () => {
    const err = new SkillPackageError('invalid_zip');
    expect(err.code).toBe('invalid_zip');
    expect(err).toBeInstanceOf(Error);
  });
});
