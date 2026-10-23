import { describe, it, expect } from 'vitest';
import type { ChatAttachment, ChatMessage } from '@ai-office/shared';
import { prepareAttachmentMessages, requiredModalitiesOf } from './attachments';

function textAttachment(content: string, filename = 'a.txt'): ChatAttachment {
  return {
    kind: 'text',
    filename,
    mime: 'text/plain',
    size: Buffer.byteLength(content),
    data: Buffer.from(content).toString('base64'),
  };
}

function message(over: Partial<ChatMessage> & { attachments?: ChatAttachment[] }): ChatMessage {
  return { role: 'user', content: '看看附件', ...over };
}

describe('prepareAttachmentMessages', () => {
  it('文本附件抽取正文并拼接边界；无媒体时保持字符串内容', async () => {
    const out = await prepareAttachmentMessages([message({ attachments: [textAttachment('你好')] })]);

    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('【附件：a.txt】');
    expect(out[0].content).toContain('你好');
    expect(out[0].parts).toBeUndefined();
  });

  it('图片/音频/视频转换为 provider 无关的 content parts', async () => {
    const out = await prepareAttachmentMessages([
      message({
        attachments: [
          { kind: 'image', filename: 'p.png', mime: 'image/png', size: 3, data: 'AQID' },
          { kind: 'audio', filename: 'a.mp3', mime: 'audio/mpeg', size: 3, data: 'BAUG' },
          { kind: 'audio', filename: 'b.m4a', mime: 'audio/mp4', size: 3, data: 'BwgJ' },
          { kind: 'video', filename: 'v.mp4', mime: 'video/mp4', size: 3, data: 'CgsM' },
        ],
      }),
    ]);

    expect(out[0].parts).toEqual([
      { type: 'text', text: '看看附件' },
      { type: 'image_url', imageUrl: 'data:image/png;base64,AQID' },
      { type: 'input_audio', data: 'BAUG', format: 'mp3' },
      { type: 'input_audio', data: 'BwgJ', format: 'm4a' },
      { type: 'video_url', videoUrl: 'data:video/mp4;base64,CgsM' },
    ]);
    expect(requiredModalitiesOf(out)).toEqual(['image', 'audio', 'video']);
  });

  it('未携带 data 的附件与解析失败的文本只留下提示，不阻断运行', async () => {
    const out = await prepareAttachmentMessages([
      message({
        attachments: [
          { kind: 'image', filename: 'big.png', mime: 'image/png', size: 99 },
          {
            kind: 'text',
            filename: 'broken.xyz',
            mime: 'application/x-unknown',
            size: 10,
            data: Buffer.from('whatever').toString('base64'),
          },
        ],
      }),
    ]);

    expect(out[0].content).toContain('【附件：big.png 未随本次运行发送（超出上下文预算）】');
    expect(out[0].content).toContain('【附件：broken.xyz 无法读取正文】');
    expect(out[0].parts).toBeUndefined();
  });

  it('文本预算按从新到旧分配，超出后只给提示', async () => {
    const huge = 'x'.repeat(100_000);
    const out = await prepareAttachmentMessages([
      message({ content: 'old', attachments: [textAttachment(huge, 'old.txt')] }),
      message({ content: 'mid', attachments: [textAttachment(huge, 'mid.txt')] }),
      message({ content: 'new', attachments: [textAttachment(huge, 'new.txt')] }),
    ]);

    // 每条最多 10 万字符，总预算 20 万：最新与中间的消息各占满，最旧的一条被降级。
    expect(out[2].content).toContain('【附件：new.txt】');
    expect(out[1].content).toContain('【附件：mid.txt】');
    expect(out[0].content).toContain('【附件：old.txt 未随本次运行发送（文本预算已用尽）】');
    expect(out[0].content).not.toContain(huge);
  });

  it('单份超长文本截断并提示', async () => {
    const out = await prepareAttachmentMessages([
      message({ attachments: [textAttachment('y'.repeat(100_001), 'long.txt')] }),
    ]);
    expect(out[0].content).toContain('……（内容过长，已截断）');
    expect(out[0].content.length).toBeLessThan(100_100);
  });

  it('requiredModalitiesOf 对纯文本消息返回空数组', async () => {
    const out = await prepareAttachmentMessages([message({ attachments: [textAttachment('hi')] })]);
    expect(requiredModalitiesOf(out)).toEqual([]);
  });
});
