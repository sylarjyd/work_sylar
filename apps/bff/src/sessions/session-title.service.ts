import { Injectable, Logger } from '@nestjs/common';
import type { RunModelRoute } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';

/** 标题生成不能拖住首轮任务：超时或失败都回落到本地截断。 */
const TITLE_TIMEOUT_MS = 5000;
const FALLBACK_TITLE_LENGTH = 20;
const MAX_TITLE_LENGTH = 30;

const TITLE_PROMPT = [
  '你是会话标题生成器。',
  '根据用户的第一条任务内容，生成一个简洁的中文会话标题。',
  '只输出标题本身：不超过 15 个汉字，不要引号、书名号、标点、序号或任何解释。',
].join('');

export interface TitleRequest {
  sessionId: string;
  tenantId: string;
  userId: string;
  goal: string;
  /** 纯附件消息没有文字内容时，用首个附件名兜底。 */
  attachmentName?: string;
  /** 已按会话模型排序的运行路由，首条即会话选定的模型。 */
  routes: RunModelRoute[];
}

@Injectable()
export class SessionTitleService {
  private readonly logger = new Logger(SessionTitleService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 首条用户消息入队后异步补标题。任务下发已经成功，这里任何失败都只记日志，
   * 不能让标题生成拖慢或破坏运行。
   */
  schedule(req: TitleRequest): void {
    void this.generate(req).catch((err) => {
      this.logger.warn(`会话 ${req.sessionId} 自动命名失败: ${(err as Error).message}`);
    });
  }

  private async generate(req: TitleRequest): Promise<void> {
    const fallback = fallbackTitle(req.goal, req.attachmentName);
    let title = fallback;
    const route = req.routes[0];
    if (route && req.goal.trim() !== '') {
      try {
        title = (await requestTitle(route, req.goal)) || fallback;
      } catch (err) {
        this.logger.warn(`会话 ${req.sessionId} 生成标题失败，使用截断标题: ${(err as Error).message}`);
      }
    }

    // 条件更新：用户已手动改名（titleSource=manual）或会话已删除时 0 行，保留用户选择。
    await this.prisma.session.updateMany({
      where: {
        id: req.sessionId,
        tenantId: req.tenantId,
        userId: req.userId,
        status: 'active',
        titleSource: 'auto',
      },
      data: { title, titleSource: 'generated' },
    });
  }
}

async function requestTitle(route: RunModelRoute, goal: string): Promise<string> {
  const res = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${route.apiKey}`,
    },
    body: JSON.stringify({
      model: route.model,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        // 只取开头一段：标题只需要判断主题，没必要把整段任务都发给模型。
        { role: 'user', content: goal.slice(0, 500) },
      ],
      max_tokens: 40,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`title_http_${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return cleanTitle(data.choices?.[0]?.message?.content ?? '');
}

/** 模型可能带回引号、换行或解释；只保留首个非空行并清掉包裹符号。 */
export function cleanTitle(raw: string): string {
  const first =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  // 先剥句末标点再剥右括号：模型常输出「标题」。，标点在内层、括号在外层。
  const stripped = first
    .replace(/^[「『“"'《【（(]+/, '')
    .replace(/[。！？!?；;，,、：:]+$/, '')
    .replace(/[」』”"'》】）)]+$/, '')
    .replace(/[。！？!?；;，,、：:]+$/, '')
    .trim();
  return clampChars(stripped, MAX_TITLE_LENGTH);
}

/** 模型不可用时的确定性兜底：首条任务清洗后截断，纯附件则用文件名。 */
export function fallbackTitle(goal: string, attachmentName?: string): string {
  const text = goal.replace(/\s+/g, ' ').trim();
  if (text !== '') return clampChars(text, FALLBACK_TITLE_LENGTH);
  const name = (attachmentName ?? '').replace(/\.[^.]+$/, '').trim();
  return name !== '' ? clampChars(name, FALLBACK_TITLE_LENGTH) : '新会话';
}

function clampChars(value: string, max: number): string {
  // 按码点截断：中文与 emoji 都是一个字符，避免把代理对劈成半个。
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('').trim() : value;
}
