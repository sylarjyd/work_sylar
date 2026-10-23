import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_SPECS,
  attachmentKindFor,
  attachmentKindLabel,
  attachmentMimeFor,
} from './dto';

describe('attachmentKindFor', () => {
  it('按扩展名识别四类附件', () => {
    expect(attachmentKindFor('note.txt')).toBe('text');
    expect(attachmentKindFor('report.PDF')).toBe('text');
    expect(attachmentKindFor('photo.png')).toBe('image');
    expect(attachmentKindFor('voice.mp3')).toBe('audio');
    expect(attachmentKindFor('clip.mp4')).toBe('video');
  });

  it('webm 由 MIME 在音频/视频之间消歧，缺省归音频', () => {
    expect(attachmentKindFor('a.webm', 'audio/webm')).toBe('audio');
    expect(attachmentKindFor('a.webm', 'video/webm')).toBe('video');
    expect(attachmentKindFor('a.webm')).toBe('audio');
  });

  it('未知扩展名即使声称受支持的 MIME 也拒绝，防止伪装内容回放', () => {
    expect(attachmentKindFor('evil.html', 'image/png')).toBeNull();
    expect(attachmentKindFor('payload', 'image/png')).toBeNull();
    expect(attachmentKindFor('noext')).toBeNull();
  });

  it('MIME 与扩展名冲突时以扩展名决定的类别为准', () => {
    // 声称是图片的 PDF 仍按文本抽取，避免走 image_url 回放。
    expect(attachmentKindFor('doc.pdf', 'image/png')).toBe('text');
    // 带参数与大小写的 MIME 归一化后再匹配。
    expect(attachmentKindFor('a.webm', 'VIDEO/WEBM; codecs=vp9')).toBe('video');
  });
});

describe('附件规格', () => {
  it('attachmentMimeFor 返回规范 MIME，不受客户端声明影响', () => {
    expect(attachmentMimeFor('a.txt', 'text')).toBe('text/plain');
    expect(attachmentMimeFor('a.jpg', 'image')).toBe('image/jpeg');
    expect(attachmentMimeFor('a.m4a', 'audio')).toBe('audio/mp4');
    expect(attachmentMimeFor('a.mov', 'video')).toBe('video/quicktime');
    // 类别不匹配时不猜测，交给上层拒绝/兜底。
    expect(attachmentMimeFor('a.exe', 'image')).toBe('application/octet-stream');
  });

  it('accept 串覆盖各类扩展名，数量上限为 10', () => {
    for (const spec of Object.values(ATTACHMENT_SPECS)) {
      for (const ext of spec.extensions) expect(ATTACHMENT_ACCEPT).toContain(`.${ext}`);
    }
    expect(ATTACHMENT_MAX_PER_MESSAGE).toBe(10);
  });

  it('类别标签可用于前端提示', () => {
    expect(attachmentKindLabel('text')).toBe('文本');
    expect(attachmentKindLabel('video')).toBe('视频');
  });
});
