import type {
  AdminTimelineNodeDto,
  AdminTimelineNodeKind,
  AdminTimelineNodeStatus,
} from '@ai-office/shared';

/** 一次运行最多抓取/展示的 step 数；溢出节点保证总节点数不超过 500。 */
export const TIMELINE_STEP_LIMIT = 500;
const NODE_LIMIT = 500;
const TOOL_LABEL_LIMIT = 64;
const FILE_LABEL_LIMIT = 100;

export interface TimelineRun {
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface TimelineStep {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: Date;
}

export interface TimelineBuildResult {
  nodes: AdminTimelineNodeDto[];
  truncated: boolean;
}

function payloadOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 按码点截断，避免切裂 emoji；绝不回传入参/结果正文。 */
function labelOf(value: unknown, fallback: string, limit: number): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return Array.from(value).slice(0, limit).join('');
}

function toolName(step: TimelineStep): string {
  return labelOf(payloadOf(step.payload).tool, '工具', TOOL_LABEL_LIMIT);
}

function resultStatus(payload: unknown): AdminTimelineNodeStatus {
  const value = payloadOf(payload);
  if (value.ok === true) return 'ok';
  if (value.reason === 'user_denied') return 'denied';
  return 'failed';
}

function makeNode(
  id: string,
  kind: AdminTimelineNodeKind,
  label: string,
  status: AdminTimelineNodeStatus,
  startedAt: Date,
  endedAt: Date | null,
): AdminTimelineNodeDto {
  return {
    id,
    kind,
    label,
    status,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
    durationMs: endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
  };
}

/**
 * 把 step 事件聚合成阶段时间线：
 * tool_call 与下一条同名 tool_result 配对；confirm_request 等待的是下一条 tool_result。
 * 标签只允许工具名、文件名与静态文案，避免把 prompt/入参/结果带进管理端。
 */
export function buildTimelineNodes(
  run: TimelineRun,
  steps: TimelineStep[],
  totalSteps = steps.length,
): TimelineBuildResult {
  const nodes: AdminTimelineNodeDto[] = [];
  const firstTs = steps[0]?.ts ?? run.endedAt;
  nodes.push(
    makeNode(
      `${run.id}:accepted`,
      'accepted',
      '已受理',
      run.status === 'running' ? 'running' : 'ok',
      run.startedAt,
      firstTs,
    ),
  );

  const consumed = new Set<number>();

  for (let i = 0; i < steps.length; i++) {
    if (consumed.has(i)) continue;
    const current = steps[i] as TimelineStep;
    const nextTs = steps[i + 1]?.ts ?? run.endedAt;

    switch (current.type) {
      case 'think': {
        const status: AdminTimelineNodeStatus = nextTs
          ? 'done'
          : run.status === 'running'
            ? 'running'
            : 'done';
        nodes.push(makeNode(current.id, 'think', '模型思考', status, current.ts, nextTs ?? null));
        break;
      }
      case 'tool_call': {
        const tool = toolName(current);
        const resultIndex = steps.findIndex(
          (candidate, index) =>
            index > i && candidate.type === 'tool_result' && toolName(candidate) === tool,
        );
        const result = resultIndex >= 0 ? steps[resultIndex] : undefined;
        if (resultIndex >= 0) consumed.add(resultIndex);
        const status: AdminTimelineNodeStatus = result
          ? resultStatus(result.payload)
          : run.status === 'running'
            ? 'running'
            : 'failed';
        nodes.push(makeNode(current.id, 'tool', tool, status, current.ts, result?.ts ?? null));
        break;
      }
      case 'tool_result': {
        // 未被 tool_call 配对的孤立结果也要展示，避免时间线断档。
        nodes.push(
          makeNode(
            current.id,
            'tool',
            toolName(current),
            resultStatus(current.payload),
            current.ts,
            null,
          ),
        );
        break;
      }
      case 'confirm_request': {
        const answer = steps.slice(i + 1).find((candidate) => candidate.type === 'tool_result');
        const status: AdminTimelineNodeStatus = answer
          ? 'done'
          : run.status === 'running'
            ? 'blocked'
            : 'failed';
        nodes.push(
          makeNode(
            current.id,
            'confirm',
            `等待确认：${toolName(current)}`,
            status,
            current.ts,
            answer?.ts ?? null,
          ),
        );
        break;
      }
      case 'artifact': {
        const label = labelOf(payloadOf(current.payload).filename, '成果文件', FILE_LABEL_LIMIT);
        nodes.push(makeNode(current.id, 'artifact', label, 'ok', current.ts, null));
        break;
      }
      case 'chart': {
        // 只展示图表标题，不回传系列数据：时间线是运行概览，不是数据面板。
        const label = labelOf(payloadOf(current.payload).title, '数据图表', FILE_LABEL_LIMIT);
        nodes.push(makeNode(current.id, 'chart', label, 'ok', current.ts, null));
        break;
      }
      case 'notice': {
        const budget = payloadOf(current.payload).code === 'budget_exceeded';
        nodes.push(
          makeNode(
            current.id,
            'notice',
            budget ? '预算超限' : '系统提示',
            budget ? 'failed' : 'done',
            current.ts,
            null,
          ),
        );
        break;
      }
      default:
        // 未知事件可能携带自由文本，宁可不展示也不冒险泄露。
        break;
    }
  }

  const finishFrom = steps[steps.length - 1]?.ts ?? run.startedAt;
  if (run.endedAt) {
    const failed = run.status === 'failed';
    nodes.push(
      makeNode(
        `${run.id}:finished`,
        'finished',
        failed ? '运行失败' : '运行结束',
        failed ? 'failed' : 'ok',
        finishFrom,
        run.endedAt,
      ),
    );
  } else {
    nodes.push(
      makeNode(`${run.id}:finished`, 'finished', '运行中', 'running', finishFrom, null),
    );
  }

  const omittedSteps = Math.max(0, totalSteps - steps.length);
  const truncated = omittedSteps > 0 || nodes.length > NODE_LIMIT;
  if (!truncated) return { nodes, truncated: false };

  const keep = Math.min(nodes.length, NODE_LIMIT - 1);
  const kept = nodes.slice(0, keep);
  const anchor = kept[kept.length - 1];
  const omittedNodes = omittedSteps + (nodes.length - kept.length);
  kept.push({
    id: `${run.id}:overflow`,
    kind: 'notice',
    label: `其余 ${omittedNodes} 个节点已省略`,
    status: 'done',
    startedAt: anchor?.endedAt ?? anchor?.startedAt ?? run.startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
  });
  return { nodes: kept, truncated: true };
}
