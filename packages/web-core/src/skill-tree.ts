import type { SkillFileEntry } from '@ai-office/shared';

/** 技能详情目录树：SKILL.md 永远在根，其余文件按路径层级组织。 */
export interface SkillTreeNode {
  key: string;
  title: string;
  /** 包内文件路径；目录节点为目录路径，SKILL.md 为固定 key。 */
  path: string;
  isLeaf: boolean;
  size?: number;
  children?: SkillTreeNode[];
}

/** SKILL.md 的虚拟节点 key：正文已入库，不需要读包。 */
export const SKILL_MD_KEY = '__skill_md__';

interface MutableDir {
  title: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: SkillTreeNode[];
}

function emptyDir(title: string, path: string): MutableDir {
  return { title, path, dirs: new Map(), files: [] };
}

/** 目录优先、同级按名称排序，避免不同上传顺序导致树结构抖动。 */
function toNodes(dir: MutableDir): SkillTreeNode[] {
  const dirs = [...dir.dirs.values()]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map<SkillTreeNode>((child) => ({
      key: child.path,
      title: child.title,
      path: child.path,
      isLeaf: false,
      children: toNodes(child),
    }));
  const files = [...dir.files].sort((a, b) => a.title.localeCompare(b.title));
  return [...dirs, ...files];
}

/**
 * 把扁平文件清单还原成目录树并补上 SKILL.md 节点。
 * 路径异常（空段、`..`）直接跳过：这些包在解析阶段就该被拒绝，这里只防御脏数据。
 */
export function buildSkillTree(files: readonly SkillFileEntry[]): SkillTreeNode[] {
  const root = emptyDir('root', '');
  for (const file of files) {
    // 绝对路径与穿越段在解析阶段就该被拒绝，这里只防御脏数据。
    if (file.path.startsWith('/') || file.path.includes('\\')) continue;
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) continue;
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${part}` : part;
      if (!dir.dirs.has(part)) dir.dirs.set(part, emptyDir(part, path));
      dir = dir.dirs.get(part)!;
    }
    const name = parts[parts.length - 1]!;
    dir.files.push({
      key: file.path,
      title: name,
      path: file.path,
      isLeaf: true,
      size: file.size,
    });
  }
  return [
    {
      key: SKILL_MD_KEY,
      title: 'SKILL.md',
      path: 'SKILL.md',
      isLeaf: true,
    },
    ...toNodes(root),
  ];
}

/** 扁平化目录树，供选中项回查与默认展开使用。 */
export function flattenSkillTree(nodes: readonly SkillTreeNode[]): SkillTreeNode[] {
  const out: SkillTreeNode[] = [];
  const walk = (list: readonly SkillTreeNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** 默认展开全部目录节点：技能包通常很小，一次展开比逐层点更快。 */
export function defaultExpandedKeys(nodes: readonly SkillTreeNode[]): string[] {
  return flattenSkillTree(nodes)
    .filter((node) => !node.isLeaf && node.key !== '')
    .map((node) => node.key);
}

/** 人类可读大小，文件清单不展示字节数细节。 */
export function formatSkillFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
