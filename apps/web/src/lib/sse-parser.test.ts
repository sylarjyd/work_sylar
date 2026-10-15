import { describe, it, expect } from 'vitest';
import { createSseParser } from './sse-parser';

describe('createSseParser', () => {
  it('跨多个网络分片拼接并逐个产出事件', () => {
    const parse = createSseParser();

    // 分片 1：第一个帧完整；第二个帧被截断在 "data:" 之前
    expect(parse('event: step\ndata: {"seq":0}\n\nevent: step\nda')).toEqual([
      { event: 'step', data: { seq: 0 } },
    ]);
    // 分片 2：补完第二个帧
    expect(parse('ta: {"seq":1}\n\n')).toEqual([
      { event: 'step', data: { seq: 1 } },
    ]);
    // 分片 3：一个新帧
    expect(parse('event: done\ndata: {"runId":"r1"}\n\n')).toEqual([
      { event: 'done', data: { runId: 'r1' } },
    ]);
  });
});
