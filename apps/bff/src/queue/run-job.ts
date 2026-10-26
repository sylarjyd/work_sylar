import { NotFoundException } from '@nestjs/common';
import { isSessionMode, type RunConfig, type RunModelRoute, type SessionMode } from '@ai-office/shared';
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
  /** 任务分类；存量快照没有该字段，按无附加提示处理。 */
  mode?: SessionMode;
  assistant: {
    systemPrompt?: string;
    enabledTools?: string[];
    permissionMode?: 'standard' | 'readonly' | 'auto';
    kbIds?: string[];
  } | null;
}

/**
 * 分类附加提示：只影响回答取向，不限制工具——限制是否可用工具由助手的技能决定。
 * 追加在助手系统提示词之后，避免覆盖用户自定义的角色设定。
 */
export const SESSION_MODE_PROMPTS: Record<SessionMode, string> = {
  chat: '当前为对话模式：直接、简洁地回答问题，通常不必调用工具，确有必要时再使用。',
  task: '当前为任务模式：先把目标拆解为可执行步骤，按需调用工具逐步完成，最后汇总结果与产出。',
  code: '当前为编码模式：优先给出可直接运行的代码并说明运行方式，需要验证时调用代码执行工具。',
};

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
  // 分类只是提示词取向：旧快照缺字段或值不可识别时忽略，不让在途作业因此失败。
  return {
    ...(raw as unknown as RunSnapshot),
    mode: isSessionMode(raw.mode) ? raw.mode : undefined,
  };
}
