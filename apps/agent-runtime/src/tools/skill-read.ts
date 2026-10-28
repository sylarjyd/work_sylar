import type { RunSkill } from '@ai-office/shared';
import type { Tool } from './types';

/** 单文件回传上限：技能包里的模板/脚本通常很小，超出按截断处理，避免撑爆上下文。 */
const MAX_FILE_BYTES = 100 * 1024;

/**
 * 技能包文件读取：只允许读本次运行已绑定技能、且清单里存在的路径。
 * 实际字节由 BFF 内部端点从 zip 解出（runtime 不直连对象存储，也不持有技能库）。
 */
export function createSkillReadTool(
  skills: readonly RunSkill[],
  env: NodeJS.ProcessEnv = process.env,
): Tool {
  const baseUrl = env.BFF_INTERNAL_URL ?? 'http://localhost:4000';
  const token = env.INTERNAL_TOKEN;
  return {
    name: 'skill.read',
    description: [
      '读取已绑定技能包内的文件（模板、脚本、参考资料）。',
      'path 必须来自系统提示词中该技能列出的文件清单；返回 UTF-8 文本，超出上限会截断。',
    ].join(' '),
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名或技能 ID' },
        path: { type: 'string', description: '包内文件路径，如 references/template.md' },
      },
      required: ['skill', 'path'],
    },
    async execute(args, ctx): Promise<{ content: string; truncated: boolean }> {
      const key = typeof args.skill === 'string' ? args.skill.trim() : '';
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!key || !path) throw new Error('invalid_skill_read');
      const target = skills.find(
        (skill) =>
          skill.id === key || skill.name === key || (skill.id.startsWith(key) && key.length >= 8),
      );
      if (!target) throw new Error('skill_not_bound');
      if (!target.files || !target.files.includes(path)) throw new Error('skill_file_not_found');

      const query = new URLSearchParams({ path, tenantId: ctx.tenantId, userId: ctx.userId });
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/internal/skills/${encodeURIComponent(target.id)}/file?${query}`, {
          headers: token ? { 'x-internal-token': token } : {},
        });
      } catch {
        throw new Error('skill_file_unavailable');
      }
      if (!res.ok) throw new Error(`skill_file_unavailable_${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const text = bytes.subarray(0, MAX_FILE_BYTES).toString('utf8');
      return { content: text, truncated: bytes.byteLength > MAX_FILE_BYTES };
    },
  };
}
