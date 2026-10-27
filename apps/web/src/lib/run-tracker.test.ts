import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@ai-office/shared';
import { RunTracker } from './run-tracker';

function ev(
  seq: number,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
  runId = 'r1',
): AgentEvent {
  return { runId, seq, type, payload, ts: 1000 + seq } as AgentEvent;
}

function make() {
  const notify = vi.fn();
  return { tracker: new RunTracker(notify), notify };
}

describe('RunTracker', () => {
  it('两个会话的事件交替写入互不串扰', () => {
    const { tracker } = make();
    tracker.begin('s1', '问题一');
    tracker.begin('s2', '问题二');
    tracker.applyStep('s1', ev(0, 'think', { text: '甲' }, 'r1'));
    tracker.applyStep('s2', ev(0, 'think', { text: '乙' }, 'r2'));
    tracker.applyStep('s1', ev(1, 'tool_call', { tool: 'x', args: {} }, 'r1'));

    expect(tracker.snapshot('s1')?.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(tracker.snapshot('s2')?.events.map((e) => e.seq)).toEqual([0]);
    expect(tracker.snapshot('s1')?.runId).toBe('r1');
    expect(tracker.snapshot('s2')?.runId).toBe('r2');
    expect(tracker.snapshot('s1')?.goal).toBe('问题一');
  });

  it('assistant_delta 累加 liveText，think 到达时清空并接管事件', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.applyStep('s1', ev(0, 'assistant_delta', { text: '你好' }));
    tracker.applyStep('s1', ev(1, 'assistant_delta', { text: '世界' }));
    expect(tracker.snapshot('s1')?.liveText).toBe('你好世界');
    expect(tracker.snapshot('s1')?.events).toHaveLength(0);

    tracker.applyStep('s1', ev(2, 'think', { text: '你好世界' }));
    expect(tracker.snapshot('s1')?.liveText).toBe('');
    expect(tracker.snapshot('s1')?.events.map((e) => e.type)).toEqual(['think']);
  });

  it('status 更新排队位次，步骤到达后清除排队提示', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.applyStatus('s1', 'queued', 3);
    expect(tracker.snapshot('s1')).toMatchObject({ status: 'queued', queuePosition: 3 });

    tracker.applyStatus('s1', 'running', null);
    expect(tracker.snapshot('s1')).toMatchObject({ status: 'running', queuePosition: null });

    tracker.applyStatus('s1', 'canceled', null);
    tracker.applyTerminal('s1');
    tracker.applyDone('s1', 'done');
    expect(tracker.snapshot('s1')).toMatchObject({ terminal: true, finalStatus: 'canceled' });
  });

  it('终态后 terminal 为真，settle 可本地收尾', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.applyDone('s1', 'failed');
    expect(tracker.snapshot('s1')).toMatchObject({ terminal: true, finalStatus: 'failed' });

    tracker.begin('s2', 'q');
    tracker.settle('s2', 'failed');
    expect(tracker.snapshot('s2')).toMatchObject({ terminal: true, finalStatus: 'failed' });
  });

  it('clear 后 snapshot 为空且不再接收事件', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.clear('s1');
    tracker.applyStep('s1', ev(0, 'think', { text: 'x' }));
    expect(tracker.has('s1')).toBe(false);
    expect(tracker.snapshot('s1')).toBeNull();
  });

  it('attach 复用同一 runId 的内存条目，换 run 则重建', () => {
    const { tracker } = make();
    const st = tracker.begin('s1', 'q', [], 'r1');
    tracker.applyStep('s1', ev(0, 'think', { text: 'x' }));
    expect(tracker.attach('s1', 'r1', -1)).toBe(st);
    expect(tracker.snapshot('s1')?.events).toHaveLength(1);

    const st2 = tracker.attach('s1', 'r2', -1);
    expect(st2).not.toBe(st);
    expect(tracker.snapshot('s1')).toMatchObject({ runId: 'r2', events: [], terminal: false });
  });

  it('停止与决策状态按会话保存', () => {
    const { tracker } = make();
    tracker.begin('s1', 'q');
    tracker.markStopping('s1');
    expect(tracker.snapshot('s1')?.status).toBe('stopping');
    tracker.clearStopping('s1');
    expect(tracker.snapshot('s1')?.status).toBe('running');

    tracker.decide('s1', 'c1', true);
    expect(tracker.snapshot('s1')?.decisions).toEqual({ c1: true });
    tracker.undecide('s1', 'c1');
    expect(tracker.snapshot('s1')?.decisions).toEqual({});
  });
});
