export const SSE_EVENT_NAMES = [
  'step',
  'usage',
  'done',
  'error',
  'status',
  'checkpoint',
] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/** 任务/运行的排队与执行状态；以 string 落库，DTO 层收窄为该联合类型。 */
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/**
 * assistant_delta 是模型正文的增量片段：只用于实时渲染，不落库，
 * 最终仍由一条完整的 think 事件承载整段回答（历史与重连都以它为准）。
 * chart 是图表工具产出的可视化规格（payload 为 ChartSpec），前端内联渲染。
 */
export type StepType =
  | 'think'
  | 'assistant_delta'
  | 'tool_call'
  | 'tool_result'
  | 'artifact'
  | 'chart'
  | 'confirm_request'
  | 'notice';

/** 排队/执行状态变更（非 Step，不入库）。 */
export interface RunStatusEvent {
  runId: string;
  status: RunStatus;
  /** 仅 queued 时给出：同租户前方等待数。 */
  position?: number;
}

/** 会话增量：续跑时回放给 runtime 的 assistant/tool 消息。 */
export interface ConversationDelta {
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolCallId?: string;
}

export interface CheckpointUsageEntry {
  model: string;
  input: number;
  output: number;
}

/** runtime → BFF 的 checkpoint；BFF 落库后不转发浏览器。 */
export interface RunCheckpointEvent {
  round: number;
  seq: number;
  /** 截至该轮的全部 assistant/tool 增量（累计值）；BFF 覆盖保存，续跑原样回放。 */
  deltas: ConversationDelta[];
  usage: CheckpointUsageEntry[];
}

/** BFF → runtime 的续跑指令。 */
export interface RunResume {
  round: number;
  seq: number;
  deltas: ConversationDelta[];
  usage: CheckpointUsageEntry[];
}

/** `notice` step 的 payload：目前只有预算超限，后续可扩展。 */
export interface NoticePayload {
  code: 'budget_exceeded';
  message: string;
}

export interface AgentEvent {
  runId: string;
  seq: number;
  type: StepType;
  payload: Record<string, unknown>;
  ts: number;
}

export interface SseMessage<T = unknown> {
  event: SseEventName;
  data: T;
}

/** 把一条消息编码为 SSE 帧（\n\n 结尾）。 */
export function encodeSse<T>(msg: SseMessage<T>): string {
  return `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
}

/** 解析单个完整帧；空帧、缺字段、事件名非法或 data 非法 JSON 时一律返回 null（不抛异常）。 */
export function parseSseFrame(frame: string): SseMessage | null {
  if (frame.trim() === '') return null;
  let event: string | undefined;
  let dataLine: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim();
  }
  if (!event || !dataLine) return null;
  if (!(SSE_EVENT_NAMES as readonly string[]).includes(event)) return null;
  try {
    return { event: event as SseEventName, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

/**
 * 从一段**已累积**的文本中解析出所有完整 SSE 帧。
 * 末尾未以 \n\n 终止的残段被丢弃（视为尚未收完，等待后续分片）。
 */
export function decodeSseFrames(text: string): SseMessage[] {
  const segments = text.split('\n\n');
  if (!text.endsWith('\n\n')) segments.pop();
  return segments
    .map(parseSseFrame)
    .filter((m): m is SseMessage => m !== null);
}

/**
 * 有状态的 SSE 解析器：维护缓冲区，跨网络分片逐个产出完整事件。
 * 原为 web 独有；BFF 需要在转发时同步解析以落库，故上移共用。
 */
export function createSseParser(): (chunk: string) => SseMessage[] {
  let buffer = '';
  return function parse(chunk: string): SseMessage[] {
    buffer += chunk;
    const events: SseMessage[] = [];
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const msg = parseSseFrame(frame);
      if (msg) events.push(msg);
    }
    return events;
  };
}
