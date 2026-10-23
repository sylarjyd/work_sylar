import type { ChatMessage, ModelModality } from '@ai-office/shared';
import { parseDocument } from '../kb/parse';
import type { ContentPart, ModelMessage } from './types';

/** 单个文本附件的抽取上限：约 2.5 万 token，避免一份超大日志挤掉全部对话。 */
const MAX_DOC_CHARS = 100_000;
/** 一次运行所有文本附件的总抽取上限；按消息从新到旧分配，优先保留最近上下文。 */
const MAX_TOTAL_DOC_CHARS = 200_000;

/**
 * 把 BFF 下发的附件元数据/字节转换成模型输入：
 * - 文本类按 parseDocument 抽取正文并拼进消息文本，带明确的附件边界与截断提示；
 * - 图片/音频/视频转成 provider 无关的 ContentPart，由网关适配器序列化；
 * - 因预算未携带 data 的附件保留一条“未发送”提示，模型不会误以为看过内容。
 * 单个附件解析失败不阻断整次运行，只降级为提示。
 */
export async function prepareAttachmentMessages(
  input: ChatMessage[],
): Promise<ModelMessage[]> {
  const out = new Array<ModelMessage>(input.length);
  let remainingChars = MAX_TOTAL_DOC_CHARS;
  // 从最新消息倒序分配预算，保证用户刚上传的内容优先进入上下文。
  for (let i = input.length - 1; i >= 0; i--) {
    const m = input[i];
    out[i] = m.attachments?.length
      ? await prepareMessage(m, () => remainingChars, (n) => (remainingChars -= n))
      : { role: m.role, content: m.content };
  }
  return out;
}

async function prepareMessage(
  m: ChatMessage,
  remaining: () => number,
  consume: (n: number) => void,
): Promise<ModelMessage> {
  let text = m.content;
  const media: ContentPart[] = [];

  for (const a of m.attachments ?? []) {
    if (!a.data) {
      text += `\n\n【附件：${a.filename} 未随本次运行发送（超出上下文预算）】`;
      continue;
    }
    if (a.kind === 'text') {
      if (remaining() <= 0) {
        text += `\n\n【附件：${a.filename} 未随本次运行发送（文本预算已用尽）】`;
        continue;
      }
      try {
        const raw = await parseDocument({
          data: Buffer.from(a.data, 'base64'),
          filename: a.filename,
          mime: a.mime,
        });
        const limit = Math.min(MAX_DOC_CHARS, remaining());
        const clipped =
          raw.length > limit ? `${raw.slice(0, limit)}\n……（内容过长，已截断）` : raw;
        text += `\n\n【附件：${a.filename}】\n${clipped}`;
        consume(Math.min(raw.length, limit));
      } catch {
        // 不把底层错误（可能含路径/解析器信息）带进 prompt，只告诉模型该附件不可读。
        text += `\n\n【附件：${a.filename} 无法读取正文】`;
      }
      continue;
    }
    if (a.kind === 'image') {
      media.push({ type: 'image_url', imageUrl: dataUrl(a.mime, a.data) });
    } else if (a.kind === 'audio') {
      media.push({ type: 'input_audio', data: a.data, format: audioFormat(a.mime) });
    } else {
      media.push({ type: 'video_url', videoUrl: dataUrl(a.mime, a.data) });
    }
  }

  const parts: ContentPart[] = [];
  if (text.length > 0) parts.push({ type: 'text', text });
  parts.push(...media);
  const hasMedia = media.length > 0;
  return {
    role: m.role,
    content: text,
    // 纯文本消息保持字符串线格式，只有出现媒体片段时才切到 parts。
    ...(hasMedia ? { parts } : {}),
  };
}

/** 从已准备好的消息推断本次运行需要的模态，供路由跳过能力不足的模型。 */
export function requiredModalitiesOf(messages: ModelMessage[]): ModelModality[] {
  const set = new Set<ModelModality>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type === 'image_url') set.add('image');
      else if (p.type === 'input_audio') set.add('audio');
      else if (p.type === 'video_url') set.add('video');
    }
  }
  return [...set];
}

function dataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** OpenAI 兼容协议的 input_audio.format 只接受短格式名。 */
function audioFormat(mime: string): string {
  const sub = mime.toLowerCase().split('/')[1] ?? '';
  if (sub === 'mpeg') return 'mp3';
  if (sub === 'mp4') return 'm4a';
  return sub || 'mp3';
}
