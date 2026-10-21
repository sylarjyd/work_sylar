import { describe, expect, it } from 'vitest';
import { timelineKindLabel, timelineStatusLabel, timelineStatusTone } from './run-timeline';

describe('run-timeline', () => {
  it('已知类型与状态返回中文标签', () => {
    expect(timelineKindLabel('think')).toBe('思考');
    expect(timelineKindLabel('tool')).toBe('工具');
    expect(timelineKindLabel('notice')).toBe('提示');
    expect(timelineStatusLabel('denied')).toBe('已拒绝');
    expect(timelineStatusLabel('blocked')).toBe('已拦截');
  });

  it('未知值回退到通用文案，避免后端新增类型导致空白', () => {
    expect(timelineKindLabel('future_kind')).toBe('事件');
    expect(timelineStatusLabel('future_status')).toBe('未知');
  });

  it('状态归并成四种视觉语气', () => {
    expect(timelineStatusTone('ok')).toBe('ok');
    expect(timelineStatusTone('done')).toBe('ok');
    expect(timelineStatusTone('failed')).toBe('bad');
    expect(timelineStatusTone('blocked')).toBe('bad');
    expect(timelineStatusTone('denied')).toBe('warn');
    expect(timelineStatusTone('running')).toBe('active');
    expect(timelineStatusTone('future_status')).toBe('active');
  });
});
