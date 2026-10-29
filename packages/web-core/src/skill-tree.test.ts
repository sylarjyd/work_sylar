import { describe, expect, it } from 'vitest';
import {
  SKILL_MD_KEY,
  buildSkillTree,
  defaultExpandedKeys,
  flattenSkillTree,
  formatSkillFileSize,
} from './skill-tree';

const files = [
  { path: 'references/template.md', size: 2048 },
  { path: 'scripts/build.py', size: 512 },
  { path: 'references/deep/nested.md', size: 10 },
  { path: 'README.md', size: 5 },
];

describe('buildSkillTree', () => {
  it('根节点固定是 SKILL.md，目录在前、同级按名称排序', () => {
    const tree = buildSkillTree(files);
    expect(tree[0]).toMatchObject({ key: SKILL_MD_KEY, title: 'SKILL.md', isLeaf: true });
    expect(tree.slice(1).map((node) => node.title)).toEqual([
      'references',
      'scripts',
      'README.md',
    ]);
    const refs = tree.find((node) => node.title === 'references')!;
    expect(refs.children?.map((node) => node.title)).toEqual(['deep', 'template.md']);
  });

  it('叶子节点保留完整路径与大小，目录节点可展开', () => {
    const tree = buildSkillTree(files);
    const flat = flattenSkillTree(tree);
    const nested = flat.find((node) => node.title === 'nested.md')!;
    expect(nested).toMatchObject({
      path: 'references/deep/nested.md',
      size: 10,
      isLeaf: true,
    });
    expect(flat.find((node) => node.title === 'deep')?.isLeaf).toBe(false);
  });

  it('没有文件时只有 SKILL.md；异常路径被跳过', () => {
    expect(buildSkillTree([])).toHaveLength(1);
    const tree = buildSkillTree([
      { path: '../evil.md', size: 1 },
      { path: '/abs.md', size: 1 },
      { path: 'ok.md', size: 1 },
    ]);
    expect(flattenSkillTree(tree).map((node) => node.title)).toEqual(['SKILL.md', 'ok.md']);
  });

  it('默认展开只包含目录，不展开文件与根', () => {
    const keys = defaultExpandedKeys(buildSkillTree(files));
    expect(keys).toEqual(['references', 'references/deep', 'scripts']);
  });
});

describe('formatSkillFileSize', () => {
  it('按量级给出可读大小', () => {
    expect(formatSkillFileSize(0)).toBe('0 B');
    expect(formatSkillFileSize(900)).toBe('900 B');
    expect(formatSkillFileSize(2048)).toBe('2.0 KB');
    expect(formatSkillFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
