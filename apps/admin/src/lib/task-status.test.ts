import { describe, it, expect } from 'vitest';
import type { RunStatus } from '@ai-office/shared';
import { canCancelRun, canRetryRun, TASK_STATUS_META } from './task-status';

const ALL: RunStatus[] = ['queued', 'running', 'done', 'failed', 'canceled'];

describe('task-status', () => {
  it('每个运行状态都有中文文案与颜色', () => {
    for (const status of ALL) {
      expect(TASK_STATUS_META[status].label).toBeTruthy();
      expect(TASK_STATUS_META[status].color).toBeTruthy();
    }
  });

  it('取消只对排队/运行中开放', () => {
    expect(ALL.filter(canCancelRun).sort()).toEqual(['queued', 'running']);
  });

  it('重试只对失败/已取消开放', () => {
    expect(ALL.filter(canRetryRun).sort()).toEqual(['canceled', 'failed']);
  });
});
