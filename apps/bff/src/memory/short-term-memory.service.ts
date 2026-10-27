import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { ChatRole } from '@ai-office/shared';
import type { PreparedMessage } from '../attachments/attachments.service';
import { RUN_REDIS } from '../queue/redis.provider';

/** 短期记忆状态 30 天未再压缩即过期：会话继续活跃才续期。 */
export const SHORT_MEMORY_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 压缩锁 15 秒自动释放：覆盖一次摘要模型调用（8s 超时）并留出余量。 */
export const SHORT_MEMORY_LOCK_MS = 15_000;
/** 窗口至少保留的最近消息条数（含本轮用户问题）。 */
export const MIN_RECENT_MESSAGES = 4;
export const SUMMARY_MAX_CHARS = 2_000;

const REDIS_TIMEOUT_MS = 500;
const FALLBACK_LINE_MAX_CHARS = 200;

/** Redis 抖动不能拖住运行链路：每条短期记忆命令都要有明确上限。 */
async function withRedisTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('memory_redis_timeout')), REDIS_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function stateKey(sessionId: string): string {
  return `mem:short:${sessionId}`;
}

export function lockKey(sessionId: string): string {
  return `mem:short:${sessionId}:lock`;
}

export interface ShortMemoryState {
  summary: string;
  /** 已被摘要覆盖的消息条数：快照只增不改，用条数即可跨轮对齐。 */
  upToCount: number;
  updatedAt: number;
}

export const ROLE_LABELS: Record<ChatRole, string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
};

/** 按 Unicode 码点计数：中文与 emoji 各算 1，避免代理对把预算算大一倍。 */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** 单条消息的预算占用：正文 + 附件文件名与大小（附件正文不计入历史预算）。 */
export function messageChars(message: PreparedMessage): number {
  const attachments = message.attachments.reduce(
    (sum, a) => sum + charCount(a.filename) + String(a.size).length,
    0,
  );
  return charCount(message.content) + attachments;
}

/**
 * 从最新消息向前累计字符数，返回窗口起点下标 cut：messages[cut..] 为下发窗口。
 * - 至少保留最近 minRecent 条；
 * - 最后一条（本轮问题）无论如何保留：单条超预算时窗口固定为最近 minRecent 条。
 */
export function computeCut(
  messages: PreparedMessage[],
  budget: number,
  minRecent = MIN_RECENT_MESSAGES,
): number {
  const total = messages.length;
  if (total === 0) return 0;
  const keepMax = Math.max(1, Math.min(minRecent, total));
  let cut = total;
  let chars = 0;
  for (let i = total - 1; i >= 0; i--) {
    const next = chars + messageChars(messages[i]);
    // 已满足最少条数后，再加一条就会超预算：窗口从 i + 1 开始。
    if (next > budget && total - i > keepMax) {
      cut = i + 1;
      break;
    }
    chars = next;
    cut = i;
  }
  // 单条消息超大时循环会把窗口压到 minRecent 以下，这里兜底回补。
  if (total - cut < keepMax) cut = total - keepMax;
  return Math.max(0, Math.min(total, cut));
}

/** 模型不可用时的确定性摘要：逐条截断拼接，超长从最旧开始丢弃。 */
export function fallbackSummary(older: PreparedMessage[], previous?: string): string {
  const lines: string[] = [];
  const head = previous?.trim();
  // 旧摘要可能本身超长：先裁剪再加，避免被后续 shift 整行丢弃。
  if (head) lines.push(clipChars(head, SUMMARY_MAX_CHARS));
  for (const m of older) {
    const text = m.content.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const names = m.attachments.map((a) => a.filename).join('、');
    lines.push(
      `${ROLE_LABELS[m.role]}: ${clipChars(text, FALLBACK_LINE_MAX_CHARS)}` +
        (names ? `（附件：${names}）` : ''),
    );
  }
  // 逐行累计字符数（含行间换行），只在最后 join 一次：避免每丢一行都重新
  // join 并分配码点数组，否则长会话下退化为 O(n²) 阻塞事件循环。
  let totalChars = Math.max(0, lines.length - 1);
  for (const line of lines) totalChars += charCount(line);
  let first = 0;
  while (first < lines.length && totalChars > SUMMARY_MAX_CHARS) {
    totalChars -= charCount(lines[first]) + (first < lines.length - 1 ? 1 : 0);
    first++;
  }
  return lines.slice(first).join('\n');
}

function parseState(raw: string): ShortMemoryState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const state = data as Record<string, unknown>;
  if (
    typeof state.summary !== 'string' ||
    !Number.isSafeInteger(state.upToCount) ||
    (state.upToCount as number) < 0
  ) {
    return null;
  }
  return {
    summary: state.summary,
    upToCount: state.upToCount as number,
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : 0,
  };
}

/**
 * 短期记忆：Redis 存「摘要 + 已覆盖条数」，锁避免并发运行重复压缩。
 * Redis 缺席时 available=false，调用方退化为纯窗口截断。
 */
@Injectable()
export class ShortTermMemoryService {
  private readonly logger = new Logger(ShortTermMemoryService.name);

  constructor(@Optional() @Inject(RUN_REDIS) private readonly redis: Redis | null) {}

  get available(): boolean {
    return Boolean(this.redis);
  }

  async load(sessionId: string): Promise<ShortMemoryState | null> {
    const redis = this.redis;
    if (!redis) return null;
    const raw = await withRedisTimeout(redis.get(stateKey(sessionId)));
    if (raw === null) return null;
    const state = parseState(raw);
    if (!state) {
      this.logger.warn(`短期记忆状态无效，按无状态处理: ${sessionId}`);
    }
    return state;
  }

  async save(sessionId: string, state: ShortMemoryState): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    await withRedisTimeout(
      redis.set(
        stateKey(sessionId),
        JSON.stringify(state),
        'EX',
        SHORT_MEMORY_TTL_SECONDS,
      ),
    );
  }

  async tryLock(sessionId: string, runId: string): Promise<boolean> {
    const redis = this.redis;
    if (!redis) return false;
    const result = await withRedisTimeout(
      redis.set(lockKey(sessionId), runId, 'PX', SHORT_MEMORY_LOCK_MS, 'NX'),
    );
    return result === 'OK';
  }

  /** 只删除自己写入的锁：锁超时后可能已被其他运行持有。 */
  async unlock(sessionId: string, runId: string): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    await withRedisTimeout(redis.eval(script, 1, lockKey(sessionId), runId) as Promise<unknown>);
  }
}
