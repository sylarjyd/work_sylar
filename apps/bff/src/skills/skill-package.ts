import { unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';
import {
  SKILL_LIMITS,
  SKILL_SLUG_PATTERN,
  normalizeSkillInput,
  type SkillFileEntry,
  type SkillInput,
} from '@ai-office/shared';

/** 技能包解析失败的稳定错误码：控制器据此映射为 400，前端据此给可读提示。 */
export class SkillPackageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SkillPackageError';
  }
}

export interface ParsedSkillPackage {
  meta: SkillInput;
  /** 包内除 SKILL.md 之外的文件（相对包根路径）。 */
  files: SkillFileEntry[];
  totalBytes: number;
}

const DECODER = new TextDecoder('utf-8', { fatal: true });

/** 归一化 zip 内的相对路径；拒绝绝对路径、`.`/`..` 与空段（防目录穿越）。 */
function safePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  return normalized;
}

function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new SkillPackageError('frontmatter_missing');
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    throw new SkillPackageError('frontmatter_invalid');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SkillPackageError('frontmatter_invalid');
  }
  return { data: data as Record<string, unknown>, body: match[2] };
}

/**
 * 解析 Agent Skills 技能包：zip 根目录（或单层目录）下必须有 SKILL.md，
 * frontmatter 提供 name/description，正文即技能指令；其余文件作为包内资源保存。
 */
export function parseSkillPackage(buffer: Buffer): ParsedSkillPackage {
  if (buffer.byteLength === 0) throw new SkillPackageError('empty_package');
  if (buffer.byteLength > SKILL_LIMITS.packageBytes) throw new SkillPackageError('package_too_large');

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new SkillPackageError('invalid_zip');
  }

  const entries = Object.entries(unzipped).filter(([path]) => !path.endsWith('/'));
  if (entries.length === 0) throw new SkillPackageError('empty_package');
  if (entries.length > SKILL_LIMITS.packageFiles) throw new SkillPackageError('too_many_files');

  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [rawPath, bytes] of entries) {
    const path = safePath(rawPath);
    if (!path) throw new SkillPackageError('invalid_path');
    if (bytes.byteLength > SKILL_LIMITS.fileBytes) throw new SkillPackageError('file_too_large');
    files.push({ path, bytes });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > SKILL_LIMITS.packageBytes) throw new SkillPackageError('package_too_large');

  // SKILL.md 允许在根目录，也允许在唯一的一层目录下（「压缩文件夹」是最常见的上传形态）。
  const atRoot = files.find((file) => file.path.toLowerCase() === 'skill.md');
  const nested = files.find(
    (file) => file.path.split('/').length === 2 && file.path.toLowerCase().endsWith('/skill.md'),
  );
  const skillMd = atRoot ?? nested;
  if (!skillMd) throw new SkillPackageError('skill_md_missing');
  const rootPrefix = skillMd.path.includes('/')
    ? skillMd.path.slice(0, skillMd.path.lastIndexOf('/') + 1)
    : '';

  let text: string;
  try {
    text = DECODER.decode(skillMd.bytes);
  } catch {
    throw new SkillPackageError('skill_md_not_utf8');
  }
  const { data, body } = parseFrontmatter(text);

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || name.length > SKILL_LIMITS.slug || !SKILL_SLUG_PATTERN.test(name)) {
    throw new SkillPackageError('invalid_name');
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) throw new SkillPackageError('description_required');

  const rawAllowed = data['allowed-tools'] ?? data.allowedTools;
  const allowedTools =
    typeof rawAllowed === 'string'
      ? rawAllowed.split(/\s+/).filter(Boolean)
      : Array.isArray(rawAllowed)
        ? rawAllowed.filter((value): value is string => typeof value === 'string')
        : [];

  const meta = normalizeSkillInput({
    name,
    slug: name,
    description,
    content: body.trim(),
    version: data.version,
    license: data.license,
    allowedTools,
  });
  if (!meta) throw new SkillPackageError('invalid_skill_md');

  // 清单只保留资源文件：SKILL.md 已作为 content 注入，重复列出只会干扰模型。
  const manifest = files
    .filter((file) => file.path !== skillMd.path)
    .map((file) => ({
      path: rootPrefix && file.path.startsWith(rootPrefix) ? file.path.slice(rootPrefix.length) : file.path,
      size: file.bytes.byteLength,
    }))
    .filter((entry) => entry.path !== '')
    .slice(0, SKILL_LIMITS.packageFiles);

  return { meta, files: manifest, totalBytes };
}

/** 从技能包中读取单个文件；路径不存在返回 null。 */
export function readSkillPackageFile(buffer: Buffer, path: string): Uint8Array | null {
  const target = safePath(path);
  if (!target) return null;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(buffer));
  } catch {
    return null;
  }
  const direct = unzipped[target];
  if (direct) return direct;
  // 包内可能有唯一一层目录：允许调用方传相对路径。
  const nestedKey = Object.keys(unzipped).find(
    (key) => key.split('/').length === target.split('/').length + 1 && key.endsWith(`/${target}`),
  );
  return nestedKey ? unzipped[nestedKey] : null;
}
