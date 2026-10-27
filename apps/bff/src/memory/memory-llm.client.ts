import { Injectable, Logger } from '@nestjs/common';
import type { RunModelRoute } from '@ai-office/shared';
import type { PreparedMessage } from '../attachments/attachments.service';
import {
  ROLE_LABELS,
  SUMMARY_MAX_CHARS,
  charCount,
  clipChars,
} from './short-term-memory.service';

const MEMORY_LLM_TIMEOUT_MS = 8_000;
const SUMMARY_MAX_TOKENS = 400;
const FACTS_MAX_TOKENS = 300;
const SUMMARY_INPUT_MAX_CHARS = 12_000;
const MESSAGE_INPUT_MAX_CHARS = 1_000;
const QUESTION_INPUT_MAX_CHARS = 4_000;
const ANSWER_INPUT_MAX_CHARS = 8_000;
export const FACT_MAX_CHARS = 500;
export const FACTS_PER_RUN = 3;

const SUMMARY_PROMPT = [
  '你是会话压缩器。把较早的对话与已有摘要合并成一份新的中文摘要。',
  '要求：不超过 2000 字；保留用户目标、已确认的事实与结论、未完成事项、关键约束；',
  '省略寒暄、重复与工具调用细节；只输出摘要正文，不要任何解释或标题。',
].join('');

const FACTS_PROMPT = [
  '你是用户长期记忆提炼器。从一次问答中提炼值得跨会话记住的信息。',
  '只记录：稳定的偏好、身份/角色、长期目标、重要事实。',
  '不要记录：一次性任务细节、寒暄、临时数据、密码/密钥/令牌等敏感凭据。',
  '输出 JSON 字符串数组（0–3 条，每条一句中文），不要输出其他内容；没有可记内容时输出 []。',
].join('');

/** 离当前最近的片段优先进入输入：更早的内容已被旧摘要覆盖。 */
function buildTranscript(older: PreparedMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    const m = older[i];
    const text = m.content.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const names = m.attachments.map((a) => a.filename).join('、');
    const line =
      `${ROLE_LABELS[m.role]}: ${clipChars(text, MESSAGE_INPUT_MAX_CHARS)}` +
      (names ? `（附件：${names}）` : '');
    const size = charCount(line) + 1;
    if (lines.length > 0 && total + size > SUMMARY_INPUT_MAX_CHARS) break;
    lines.unshift(line);
    total += size;
  }
  return lines.join('\n');
}

/** 去掉模型可能带回的代码围栏与包裹引号，并压到 2000 字。 */
export function sanitizeSummary(raw: string): string {
  const text = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .trim();
  return clipChars(text, SUMMARY_MAX_CHARS).trim();
}

/** 从模型输出里截取 JSON 数组；非法或空数组返回 []。 */
export function parseFacts(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (typeof item !== 'string') continue;
    const text = clipChars(item.replace(/\s+/g, ' ').trim(), FACT_MAX_CHARS).trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    facts.push(text);
    if (facts.length >= FACTS_PER_RUN) break;
  }
  return facts;
}

/** 记忆用的模型调用：直连会话选定模型（与 SessionTitleService 同款模式）。 */
@Injectable()
export class MemoryLlmClient {
  private readonly logger = new Logger(MemoryLlmClient.name);

  /** 生成新摘要；模型失败/空输出返回 null，由调用方走确定性兜底。 */
  async summarize(
    route: RunModelRoute,
    older: PreparedMessage[],
    previous?: string,
  ): Promise<string | null> {
    const transcript = buildTranscript(older);
    const memory = clipChars(previous?.trim() ?? '', SUMMARY_MAX_CHARS);
    if (transcript === '' && memory === '') return null;
    const user = [
      memory ? `【已有摘要】\n${memory}` : '',
      transcript ? `【新增对话】\n${transcript}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const raw = await this.chat(route, SUMMARY_PROMPT, user, SUMMARY_MAX_TOKENS);
    if (raw === null) return null;
    const summary = sanitizeSummary(raw);
    return summary === '' ? null : summary;
  }

  /** 提炼长期事实；失败或无可记内容返回空数组。 */
  async extractFacts(
    route: RunModelRoute,
    question: string,
    answer: string,
  ): Promise<string[]> {
    const user = [
      `【用户问题】\n${clipChars(question, QUESTION_INPUT_MAX_CHARS)}`,
      `【助手回答】\n${clipChars(answer, ANSWER_INPUT_MAX_CHARS)}`,
    ].join('\n\n');
    const raw = await this.chat(route, FACTS_PROMPT, user, FACTS_MAX_TOKENS);
    return raw === null ? [] : parseFacts(raw);
  }

  /** 任何失败都只记日志并返回 null：提炼是收尾增强，绝不能影响运行终态。 */
  private async chat(
    route: RunModelRoute,
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${route.apiKey}`,
        },
        body: JSON.stringify({
          model: route.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(MEMORY_LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        this.logger.warn(`记忆模型返回 ${res.status}，本次降级`);
        return null;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    } catch (err) {
      this.logger.warn(`记忆模型调用失败，本次降级: ${(err as Error).message}`);
      return null;
    }
  }
}
