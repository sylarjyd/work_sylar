import type { RunStatus } from '@ai-office/shared';

/** 任务状态与最近运行状态共用同一套文案/颜色，避免同一含义在不同列显示不一致。 */
export const TASK_STATUS_META: Record<RunStatus, { label: string; color: string }> = {
  queued: { label: '排队中', color: 'gold' },
  running: { label: '运行中', color: 'processing' },
  done: { label: '完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
  canceled: { label: '已取消', color: 'default' },
};

/** 终态再取消只会白白打一次接口，按钮只对排队/运行中的运行开放。 */
export function canCancelRun(status: RunStatus): boolean {
  return status === 'running' || status === 'queued';
}

/** 重试只针对失败/已取消；运行中或已完成不能重复排队。 */
export function canRetryRun(status: RunStatus): boolean {
  return status === 'failed' || status === 'canceled';
}
