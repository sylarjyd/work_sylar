import type {
  AgentEvent,
  AttachmentKind,
  RunStatus,
} from '@ai-office/shared';
import { createRunStreamState, type RunStreamState } from './run-stream';

/** 尚未终结时的视觉阶段；stopping 表示取消请求已发出、等终态帧。 */
export type RunPhase = 'queued' | 'running' | 'stopping';
export type FinalRunStatus = 'done' | 'failed' | 'canceled';

/** 本轮提交的附件；previewUrl 只在本页内存中用于即时预览。 */
export interface RunAttachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  previewUrl?: string;
}

export interface RunEntry {
  runId: string;
  status: RunPhase;
  queuePosition: number | null;
  /** 已消费的最大 step 序号，重连游标。 */
  lastSeq: number;
  events: AgentEvent[];
  /** 当前 think 的增量文本（未落库）。 */
  liveText: string;
  decisions: Record<string, boolean>;
  terminal: boolean;
  finalStatus: FinalRunStatus | null;
  /** 本轮提问与附件：切走再切回时仍能看到提问气泡。 */
  goal: string;
  attachments: RunAttachment[];
}

interface TrackedRun {
  stream: RunStreamState;
  entry: RunEntry;
}

/**
 * 按会话保存运行态：切走不丢、切回直接渲染。
 * 纯 TS、无 React 依赖；每次变更后调用 notify，由页面触发重渲染。
 */
export class RunTracker {
  private readonly runs = new Map<string, TrackedRun>();

  constructor(private readonly notify: () => void) {}

  /** 新起一轮：覆盖该会话旧条目，返回可交给 consumeRunStream 的流状态。 */
  begin(
    sessionId: string,
    goal: string,
    attachments: RunAttachment[] = [],
    runId = '',
  ): RunStreamState {
    const stream = createRunStreamState();
    stream.runId = runId;
    this.runs.set(sessionId, {
      stream,
      entry: {
        runId,
        // 新建 run 落库即 queued，先按排队展示，首个步骤或状态帧再切执行中。
        status: 'queued',
        queuePosition: null,
        lastSeq: -1,
        events: [],
        liveText: '',
        decisions: {},
        terminal: false,
        finalStatus: null,
        goal,
        attachments,
      },
    });
    this.notify();
    return stream;
  }

  /**
   * 挂回一条已存在的运行：内存里同 runId 的条目原样沿用（切走再切回），
   * 否则按 afterSeq 新建条目，由调用方从头回放。
   */
  attach(sessionId: string, runId: string, afterSeq = -1): RunStreamState {
    const existing = this.runs.get(sessionId);
    if (existing && existing.stream.runId === runId) return existing.stream;
    const stream = createRunStreamState();
    stream.runId = runId;
    stream.lastSeq = afterSeq;
    this.runs.set(sessionId, {
      stream,
      entry: {
        runId,
        status: 'running',
        queuePosition: null,
        lastSeq: afterSeq,
        events: [],
        liveText: '',
        decisions: {},
        terminal: false,
        finalStatus: null,
        goal: '',
        attachments: [],
      },
    });
    this.notify();
    return stream;
  }

  applyStep(sessionId: string, ev: AgentEvent): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    const { entry } = run;
    if (typeof ev.runId === 'string' && ev.runId) entry.runId = ev.runId;
    if (typeof ev.seq === 'number') entry.lastSeq = Math.max(entry.lastSeq, ev.seq);
    // 收到步骤说明已经开始执行，清掉排队提示。
    if (entry.status === 'queued') entry.status = 'running';
    entry.queuePosition = null;
    if (ev.type === 'assistant_delta') {
      // 增量只喂给实时气泡；完整 think 到达时会用全文替换，避免两处重复。
      const text = typeof ev.payload.text === 'string' ? ev.payload.text : '';
      if (text) entry.liveText += text;
      this.notify();
      return;
    }
    if (ev.type === 'think') entry.liveText = '';
    entry.events.push(ev);
    this.notify();
  }

  applyStatus(sessionId: string, status: RunStatus, position: number | null): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    const { entry } = run;
    if (status === 'queued') {
      entry.status = 'queued';
      entry.queuePosition = position;
    } else if (status === 'running') {
      // 取消请求已发出时保持 stopping，等终态帧收尾。
      if (entry.status !== 'stopping') entry.status = 'running';
      entry.queuePosition = null;
    } else {
      // done/failed/canceled 只记录终态，收尾由 applyTerminal 统一处理。
      entry.finalStatus = status;
    }
    this.notify();
  }

  applyDone(sessionId: string, status: RunStatus): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    if (!run.entry.finalStatus) {
      run.entry.finalStatus =
        status === 'canceled' || status === 'failed' ? status : 'done';
    }
    run.entry.terminal = true;
    run.entry.liveText = '';
    this.notify();
  }

  applyError(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.entry.finalStatus = run.entry.finalStatus ?? 'failed';
    run.entry.terminal = true;
    run.entry.liveText = '';
    this.notify();
  }

  applyTerminal(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.entry.terminal = true;
    run.entry.finalStatus = run.entry.finalStatus ?? 'done';
    if (run.entry.status === 'stopping') run.entry.status = 'running';
    run.entry.liveText = '';
    this.notify();
  }

  /** 流彻底失联时本地收尾，避免输入框永久只读。 */
  settle(sessionId: string, status: FinalRunStatus = 'failed'): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    run.entry.terminal = true;
    run.entry.finalStatus = status;
    run.entry.liveText = '';
    this.notify();
  }

  markStopping(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal) return;
    run.entry.status = 'stopping';
    this.notify();
  }

  clearStopping(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run || run.entry.terminal || run.entry.status !== 'stopping') return;
    run.entry.status = 'running';
    this.notify();
  }

  decide(sessionId: string, confirmId: string, approved: boolean): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.entry.decisions = { ...run.entry.decisions, [confirmId]: approved };
    this.notify();
  }

  undecide(sessionId: string, confirmId: string): void {
    const run = this.runs.get(sessionId);
    if (!run || !(confirmId in run.entry.decisions)) return;
    const next = { ...run.entry.decisions };
    delete next[confirmId];
    run.entry.decisions = next;
    this.notify();
  }

  has(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  clear(sessionId: string): void {
    if (this.runs.delete(sessionId)) this.notify();
  }

  snapshot(sessionId: string): RunEntry | null {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    return {
      ...run.entry,
      events: run.entry.events.slice(),
      decisions: { ...run.entry.decisions },
      attachments: run.entry.attachments.slice(),
    };
  }
}
