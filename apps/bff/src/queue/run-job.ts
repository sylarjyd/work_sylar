import { NotFoundException } from '@nestjs/common';
import type { RunConfig, RunModelRoute } from '@ai-office/shared';
import type { PreparedMessage } from '../attachments/attachments.service';

/** 队列作业：只带标识，执行细节从 Task.input 快照读取，避免作业体过大。 */
export interface RunJob {
  runId: string;
  taskId: string;
  sessionId: string;
  tenantId: string;
  userId: string;
}

/**
 * 入队时固化到 Task.input 的运行快照：执行器不再读 settings/catalog，
 * 避免排队期间配置漂移导致「入队校验的参数」与「实际执行的参数」不一致。
 */
export interface RunSnapshot {
  goal: string;
  messages: PreparedMessage[];
  /** 会话/助手选定模型；null 表示由套餐顺序决定。 */
  model: string | null;
  /** 入队时解析好的模型路由与选中模型。 */
  resolution: { selectedModel: string; modelRoutes: RunModelRoute[] };
  /** 入队时的运行参数（maxRounds/timeouts 等）。 */
  config: Required<RunConfig>;
  traceId: string | null;
  assistant: {
    systemPrompt?: string;
    enabledTools?: string[];
    permissionMode?: 'standard' | 'readonly' | 'auto';
    kbIds?: string[];
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验并转换 Task.input 中的运行快照。
 * 旧数据或异常写入会产生残缺快照，必须在执行器里一次性拒绝，
 * 否则会在 hold 未释放时抛出未预期异常导致 run 永久 running。
 */
export function parseSnapshot(raw: unknown): RunSnapshot {
  if (!isRecord(raw)) throw new NotFoundException('task_snapshot_missing');
  const { goal, messages, config, resolution, model, traceId, assistant } = raw;
  if (
    typeof goal !== 'string' ||
    !Array.isArray(messages) ||
    !isRecord(config) ||
    !isRecord(resolution) ||
    typeof resolution.selectedModel !== 'string' ||
    resolution.selectedModel.length === 0 ||
    !Array.isArray(resolution.modelRoutes) ||
    !(typeof model === 'string' || model === null) ||
    !(typeof traceId === 'string' || traceId === null) ||
    !(assistant === null || isRecord(assistant))
  ) {
    throw new NotFoundException('task_snapshot_missing');
  }
  return raw as unknown as RunSnapshot;
}
