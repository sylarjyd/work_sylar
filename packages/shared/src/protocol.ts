export const SSE_EVENT_NAMES = ['step', 'usage', 'done', 'error'] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

export type StepType = 'think' | 'tool_call' | 'tool_result' | 'artifact';

export interface AgentEvent {
  runId: string;
  seq: number;
  type: StepType;
  payload: Record<string, unknown>;
  ts: number;
}

export interface PromptRequest {
  goal: string;
  sessionId?: string;
}

export interface SseMessage<T = unknown> {
  event: SseEventName;
  data: T;
}

/** 把一条消息编码为 SSE 帧（\n\n 结尾）。 */
export function encodeSse<T>(msg: SseMessage<T>): string {
  return `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
}

/** 解析单个完整帧；空帧或不合法帧返回 null。 */
export function parseSseFrame(frame: string): SseMessage | null {
  if (frame.trim() === '') return null;
  let event: string | undefined;
  let dataLine: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim();
  }
  if (!event || dataLine === undefined) return null;
  return { event: event as SseEventName, data: JSON.parse(dataLine) };
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
