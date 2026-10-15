import { describe, it, expect } from 'vitest';
import { runFakeAgent } from './fake-agent';

describe('runFakeAgent', () => {
  it('按序产出 think→tool_call→tool_result→artifact，seq 从 0 递增', async () => {
    const events = [];
    for await (const ev of runFakeAgent('调研竞品', 'run-1')) events.push(ev);

    expect(events.map((e) => e.type)).toEqual([
      'think',
      'tool_call',
      'tool_result',
      'artifact',
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.every((e) => e.runId === 'run-1')).toBe(true);
  });
});
