import type {
  AgentEvent,
  RunStatus,
  RunStatusEvent,
  SseMessage,
} from '@ai-office/shared';
import { createSseParser } from './sse-parser';

/**
 * 一次发送对应的事件流状态：runId/lastSeq/terminal 由事件处理器同步更新，
 * 断线重连时直接复用，避免依赖可能滞后一帧的 React state。
 */
export interface RunStreamState {
  runId: string;
  lastSeq: number;
  terminal: boolean;
  lastStatus: RunStatus | null;
}

export function createRunStreamState(): RunStreamState {
  // seq 从 0 开始，未收到任何 step 时用 -1 从头回放。
  return { runId: '', lastSeq: -1, terminal: false, lastStatus: null };
}

export interface RunStreamHandlers {
  onStep(ev: AgentEvent): void;
  onStatus(status: RunStatus, position: number | null): void;
  onDone(status: RunStatus): void;
  /** message 已从帧里提取好，调用方直接展示即可。 */
  onError(message: string): void;
  /** 流终结时恰好调用一次，用于解除「正在停止…」等过渡态。 */
  onTerminal(): void;
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'canceled';
}

/** 先到先得：终态帧可能重复（如 canceled 后补 done），onTerminal 只能触发一次。 */
function markTerminal(st: RunStreamState, h: RunStreamHandlers): void {
  if (st.terminal) return;
  st.terminal = true;
  h.onTerminal();
}

/** 处理单条 SSE 事件：初次流与断线重连共用，回放与实时的语义保持一致。 */
export function applyRunStreamMessage(
  m: SseMessage,
  st: RunStreamState,
  h: RunStreamHandlers,
): void {
  if (m.event === 'step') {
    const ev = m.data as AgentEvent;
    if (typeof ev.runId === 'string' && ev.runId) st.runId = ev.runId;
    if (typeof ev.seq === 'number') st.lastSeq = Math.max(st.lastSeq, ev.seq);
    h.onStep(ev);
    return;
  }
  if (m.event === 'status') {
    const d = m.data as Partial<RunStatusEvent> | null;
    if (!d || typeof d.status !== 'string') return;
    const status = d.status as RunStatus;
    if (typeof d.runId === 'string' && d.runId) st.runId = d.runId;
    st.lastStatus = status;
    // position 只对 queued 有意义；非 queued 即便带了数值也要清掉前端旧提示。
    h.onStatus(
      status,
      status === 'queued' && typeof d.position === 'number' ? d.position : null,
    );
    if (isTerminalStatus(status)) markTerminal(st, h);
    return;
  }
  if (m.event === 'done') {
    // 取消/失败会先发 status 再补 done，不能被 done 覆盖成「已完成」。
    const final: RunStatus =
      st.lastStatus === 'canceled' || st.lastStatus === 'failed' ? st.lastStatus : 'done';
    const alreadyTerminal = st.terminal;
    st.terminal = true;
    h.onDone(final);
    // 终态 status 已触发过 onTerminal 时不再重复触发。
    if (!alreadyTerminal) h.onTerminal();
    return;
  }
  if (m.event === 'error') {
    const d = m.data as { message?: unknown } | null;
    const message = d && typeof d.message === 'string' ? d.message : JSON.stringify(m.data);
    const alreadyTerminal = st.terminal;
    st.terminal = true;
    h.onError(message);
    if (!alreadyTerminal) h.onTerminal();
  }
  // 其他事件（usage/checkpoint）与浏览器无关，忽略。
}

export async function consumeRunStream(
  res: Response,
  st: RunStreamState,
  h: RunStreamHandlers,
): Promise<void> {
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const m of parse(decoder.decode(value, { stream: true }))) {
      applyRunStreamMessage(m, st, h);
    }
  }
}
