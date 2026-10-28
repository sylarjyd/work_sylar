import type { AdminTimelineNodeKind, AdminTimelineNodeStatus } from '@ai-office/shared';

const KIND_LABEL: Record<AdminTimelineNodeKind, string> = {
  accepted: '已受理',
  think: '思考',
  tool: '工具',
  confirm: '确认',
  artifact: '成果',
  chart: '图表',
  notice: '提示',
  finished: '完成',
};

const STATUS_LABEL: Record<AdminTimelineNodeStatus, string> = {
  ok: '成功',
  failed: '失败',
  denied: '已拒绝',
  blocked: '已拦截',
  running: '进行中',
  done: '完成',
};

export type TimelineTone = 'ok' | 'bad' | 'warn' | 'active';

/** 后端新增枚举时前端仍能显示，不因未知值出现空白节点。 */
export function timelineKindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? '事件';
}

export function timelineStatusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? '未知';
}

export function timelineStatusTone(status: string): TimelineTone {
  switch (status) {
    case 'ok':
    case 'done':
      return 'ok';
    case 'failed':
    case 'blocked':
      return 'bad';
    case 'denied':
      return 'warn';
    default:
      return 'active';
  }
}
