import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AgentEvent, ChatMessage, SessionMode, SkillTestResultDto } from '@ai-office/shared';
import { ModelCatalogService } from '../models/model-catalog.service';
import { skillsToPrompt } from '../queue/run-job';
import { SkillsService } from './skills.service';

const TEST_TIMEOUT_MS = 120_000;
const MAX_PROMPT = 2_000;

/**
 * 技能测试：用真实模型跑一次「只注入该技能」的对话，验证提示词是否按预期生效。
 * 不建会话、不写库、不计费——它只回答「这段技能写得好不好用」。
 */
@Injectable()
export class SkillTestService {
  private readonly logger = new Logger(SkillTestService.name);

  constructor(
    private readonly skills: SkillsService,
    private readonly catalog: ModelCatalogService,
  ) {}

  async run(
    scope: { tenantId: string; userId: string },
    id: string,
    body: unknown,
  ): Promise<SkillTestResultDto> {
    const record = (body ?? {}) as Record<string, unknown>;
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT) throw new BadRequestException('invalid_prompt');
    const model = typeof record.model === 'string' && record.model ? record.model : null;

    // 复用运行期的可见性规则：公共启用或本人个人技能。
    const skills = await this.skills.resolveForRun([id], scope.tenantId, scope.userId);
    const skill = skills[0];
    if (!skill) throw new NotFoundException('skill_not_found');

    const resolution = await this.catalog.resolveForRun(scope.tenantId, model);
    const runId = randomUUID();
    const systemPrompt = [
      '你是技能测试助手。请严格按照「已启用技能」中的要求完成用户任务，直接回答，不要调用工具。',
      skillsToPrompt(skills),
    ]
      .filter(Boolean)
      .join('\n\n');

    const baseUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const token = process.env.AGENT_RUNTIME_TOKEN;
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-agent-runtime-token': token } : {}),
        },
        body: JSON.stringify({
          runId,
          sessionId: `skill-test-${runId}`,
          tenantId: scope.tenantId,
          userId: scope.userId,
          goal: prompt,
          messages,
          config: { maxRounds: 1, confirmTimeoutMs: 1_000, codeExecTimeoutMs: 1_000 },
          modelRoutes: resolution.modelRoutes,
          systemPrompt,
          mode: 'chat' satisfies SessionMode,
          // 测试只验证提示词效果，不允许联网/写文件等副作用工具。
          enabledTools: [],
          permissionMode: 'readonly',
        }),
        signal: abort.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      this.logger.warn(`技能测试请求 runtime 失败: ${(err as Error).message}`);
      throw new BadRequestException('runtime_unavailable');
    }

    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      this.logger.warn(`技能测试 runtime 返回 ${upstream.status}`);
      throw new BadRequestException('runtime_unavailable');
    }

    let reply = '';
    let failure = '';
    try {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? '';
          const dataLine = /^data: (.*)$/m.exec(frame)?.[1];
          if (!dataLine) continue;
          let data: unknown;
          try {
            data = JSON.parse(dataLine);
          } catch {
            continue;
          }
          if (event === 'step') {
            const step = data as AgentEvent;
            if (step.type === 'think' && typeof step.payload.text === 'string') {
              reply = step.payload.text;
            }
          } else if (event === 'error') {
            failure = String((data as { message?: unknown }).message ?? 'run_failed');
          }
        }
      }
    } catch (err) {
      // 超时/中断：已有部分结果就返回，避免用户白等一场。
      if (!reply) {
        this.logger.warn(`技能测试中断: ${(err as Error).message}`);
        throw new BadRequestException('runtime_timeout');
      }
    } finally {
      clearTimeout(timer);
    }

    if (!reply && failure) throw new BadRequestException('runtime_failed');
    return {
      reply: reply || '（模型没有返回内容）',
      model: resolution.selectedModel,
    };
  }
}
