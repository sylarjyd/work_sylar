import { unzipSync, zipSync, strToU8 } from 'fflate';
import { parse as parseYaml } from 'yaml';
import {
  SKILL_LIMITS,
  SKILL_SLUG_PATTERN,
  normalizeSkillInput,
  type SkillFileContent,
  type SkillFileEntry,
  type SkillInput,
  type SkillPackageContentsDto,
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

/** 按 frontmatter 规范拼出 SKILL.md：字段顺序固定，便于 diff。 */
export function renderSkillMd(meta: SkillInput): string {
  const lines = ['---', `name: ${meta.slug ?? meta.name}`];
  if (meta.description) lines.push(`description: ${meta.description}`);
  if (meta.version) lines.push(`version: ${meta.version}`);
  if (meta.license) lines.push(`license: ${meta.license}`);
  if (meta.allowedTools && meta.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${meta.allowedTools.join(' ')}`);
  }
  lines.push('---', '', meta.content.trim(), '');
  return lines.join('\n');
}

/** 去掉「压缩文件夹」带出来的唯一一层根目录，避免编辑后包内路径多一层前缀。 */
function stripPackageRoot(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const keys = Object.keys(entries).filter((key) => !key.endsWith('/'));
  const roots = new Set(keys.map((key) => key.split('/')[0]));
  const singleRoot = roots.size === 1 ? [...roots][0]! : '';
  const hasRootSkillMd = singleRoot !== '' && keys.some((key) => key === `${singleRoot}/SKILL.md`);
  if (!hasRootSkillMd) return entries;
  const out: Record<string, Uint8Array> = {};
  for (const [key, bytes] of Object.entries(entries)) {
    const stripped = key.slice(singleRoot.length + 1);
    if (stripped) out[stripped] = bytes;
  }
  return out;
}

/**
 * 编辑器保存：以旧包为底（二进制文件原样保留），删掉被移除/覆盖的文本文件，
 * 重新生成根目录 SKILL.md，再打包回 zip。
 */
export function buildSkillZip(
  meta: SkillInput,
  files: readonly SkillFileContent[],
  deleted: readonly string[],
  base?: Buffer | null,
): { zip: Buffer; manifest: SkillFileEntry[] } {
  let entries: Record<string, Uint8Array> = {};
  if (base && base.byteLength > 0) {
    try {
      entries = stripPackageRoot(unzipSync(new Uint8Array(base)));
    } catch {
      throw new SkillPackageError('invalid_zip');
    }
  }
  const drop = new Set<string>([...deleted, ...files.map((file) => file.path)]);
  for (const key of Object.keys(entries)) {
    const lower = key.toLowerCase();
    if (lower === 'skill.md' || lower.endsWith('/skill.md')) delete entries[key];
    else if (drop.has(key)) delete entries[key];
  }
  entries['SKILL.md'] = strToU8(renderSkillMd(meta));
  for (const file of files) entries[file.path] = strToU8(file.content);

  const zip = Buffer.from(zipSync(entries, { level: 6 }));
  const manifest = Object.entries(entries)
    .filter(([path]) => path !== 'SKILL.md')
    .map(([path, bytes]) => ({ path, size: bytes.byteLength }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { zip, manifest };
}

/** 读取技能包供编辑器使用：UTF-8 文本进编辑器，其余只列清单。 */
export function readSkillPackageTexts(buffer: Buffer): SkillPackageContentsDto {
  let raw: Record<string, Uint8Array>;
  try {
    raw = stripPackageRoot(unzipSync(new Uint8Array(buffer)));
  } catch {
    throw new SkillPackageError('invalid_zip');
  }
  const files: SkillFileContent[] = [];
  const binary: SkillFileEntry[] = [];
  for (const [path, bytes] of Object.entries(raw)) {
    if (path.endsWith('/') || path === 'SKILL.md') continue;
    if (bytes.byteLength > SKILL_LIMITS.fileBytes) {
      binary.push({ path, size: bytes.byteLength });
      continue;
    }
    try {
      files.push({ path, content: DECODER.decode(bytes) });
    } catch {
      binary.push({ path, size: bytes.byteLength });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  binary.sort((a, b) => a.path.localeCompare(b.path));
  return { files, binary };
}
