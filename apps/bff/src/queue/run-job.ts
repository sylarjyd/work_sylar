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
