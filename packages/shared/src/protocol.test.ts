import { describe, it, expect } from 'vitest';
import { encodeSse, decodeSseFrames } from './protocol';

describe('encodeSse', () => {
  it('编码为合法的 SSE 帧', () => {
    expect(encodeSse({ event: 'step', data: { a: 1 } })).toBe(
      'event: step\ndata: {"a":1}\n\n',
    );
  });
});

describe('decodeSseFrames', () => {
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
