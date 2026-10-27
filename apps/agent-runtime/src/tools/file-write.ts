import type { Storage } from '../storage/s3';
import type { Tool } from './types';
import { emit } from './doc';

/** 单文件上限：成果区要能下载，2MiB 足够容纳代码与文本表格，也避免模型灌入超大内容。 */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * 允许落成成果文件的扩展名白名单：只收纯文本格式，
 * 避免把二进制内容（或可执行文件）当作下载产物落到对象存储。
 */
const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'log',
  'properties',
  'gradle',
  'sql',
  'java',
  'kt',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'rb',
  'sh',
  'bat',
  'ps1',
  'vue',
  'css',
  'scss',
]);

export function isTextFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return false;
  return TEXT_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

/** 把模型生成的文本内容保存为成果文件；代码类结果由此进入成果区，而不是只停留在聊天正文。 */
export function createFileTools(storage: Storage): Tool[] {
  return [
    {
      name: 'file.write',
      description:
        '把文本内容保存为成果文件（.java/.ts/.py/.md/.csv 等纯文本格式），返回产出物引用；编码与任务类结果应使用它落成文件。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名（含扩展名），如 UploadController.java' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['filename', 'content'],
      },
      permission: 'safe',
      async execute(args, ctx) {
        const filename = String(args.filename ?? '').trim();
        const content = typeof args.content === 'string' ? args.content : '';
        if (!filename) throw new Error('missing_filename');
        if (!content.trim()) throw new Error('missing_content');
        if (!isTextFilename(filename)) throw new Error('unsupported_file_type');
        const bytes = Buffer.from(content, 'utf8');
        if (bytes.length > MAX_BYTES) throw new Error('file_too_large');
        return emit(storage, ctx, 'text', filename, bytes);
      },
    },
  ];
}
