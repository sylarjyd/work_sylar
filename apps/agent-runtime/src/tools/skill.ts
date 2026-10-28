import { normalizeSkillInput } from '@ai-office/shared';
import type { Tool } from './types';

/**
 * 技能沉淀工具：用户说「把这次执行总结成技能」时，由模型提炼名称、简介与可复用步骤。
 * 只允许在用户明确要求时调用——否则模型会把每轮对话都存成技能，市场很快被噪声淹没。
 * 落库由 BFF 完成（runtime 无数据库权限），这里只负责校验与回传草稿。
 */
export function createSkillTool(): Tool {
  return {
    name: 'skill.save',
    description: [
      '把本次执行中可复用的做法总结成技能，保存到用户的个人技能库。',
      '仅在用户明确要求「总结为技能 / 保存成技能 / 更新某技能」时调用。',
      'content 写成可执行的步骤与注意事项，不要包含本次任务的具体数据。',
    ].join(' '),
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（不超过 40 字）' },
        description: { type: 'string', description: '一句话简介（不超过 200 字）' },
        content: {
          type: 'string',
          description: '技能正文：适用场景、步骤、注意事项（不超过 4000 字）',
        },
      },
      required: ['name', 'content'],
    },
    async execute(args): Promise<{ ok: true; skill: { name: string; description: string; content: string } }> {
      const skill = normalizeSkillInput(args);
      if (!skill) {
        throw new Error(
          'invalid_skill：name 与 content 必填，name 不超过 40 字、content 不超过 4000 字',
        );
      }
      return { ok: true, skill };
    },
  };
}
