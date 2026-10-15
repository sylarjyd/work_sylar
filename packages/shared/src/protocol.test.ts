import { describe, it, expect } from 'vitest';
import { encodeSse, decodeSseFrames, parseSseFrame } from './protocol';

describe('encodeSse', () => {
  it('编码为合法的 SSE 帧', () => {
    expect(encodeSse({ event: 'step', data: { a: 1 } })).toBe(
      'event: step\ndata: {"a":1}\n\n',
    );
  });
});

describe('parseSseFrame', () => {
  it('空帧返回 null', () => {
    expect(parseSseFrame('')).toBeNull();
    expect(parseSseFrame('   ')).toBeNull();
  });

  it('缺少 event 行返回 null', () => {
    expect(parseSseFrame('data: 1')).toBeNull();
  });

  it('缺少 data 行返回 null', () => {
    expect(parseSseFrame('event: step')).toBeNull();
  });

  it('事件名非法返回 null', () => {
    expect(parseSseFrame('event: bogus\ndata: 1')).toBeNull();
  });

  it('data 为非法 JSON 返回 null 而不抛异常', () => {
    expect(parseSseFrame('event: error\ndata: not-json')).toBeNull();
    expect(parseSseFrame('event: error\ndata:')).toBeNull();
  });
});

describe('decodeSseFrames', () => {
  it('空字符串返回空数组', () => {
    expect(decodeSseFrames('')).toEqual([]);
  });

  it('解析一个完整帧', () => {
    const out = decodeSseFrames(encodeSse({ event: 'done', data: { runId: 'r1' } }));
    expect(out).toEqual([{ event: 'done', data: { runId: 'r1' } }]);
  });

  it('解析连续两个完整帧', () => {
    const text =
      encodeSse({ event: 'step', data: { seq: 0 } }) +
      encodeSse({ event: 'done', data: { runId: 'r1' } });
    expect(decodeSseFrames(text)).toEqual([
      { event: 'step', data: { seq: 0 } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
  });

  it('尾部的半截帧被忽略，不抛异常', () => {
    const text =
      encodeSse({ event: 'step', data: { seq: 0 } }) + 'event: step\ndata: {"seq":';
    expect(decodeSseFrames(text)).toEqual([{ event: 'step', data: { seq: 0 } }]);
  });
});
