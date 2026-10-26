import { describe, it, expect } from 'vitest';
import { encodeSse, type AgentEvent, type RunStatus, type SseMessage } from '@ai-office/shared';
import {
  applyRunStreamMessage,
  consumeRunStream,
  createRunStreamState,
  type RunStreamHandlers,
  type RunStreamState,
} from './run-stream';

interface Recorder extends RunStreamHandlers {
  steps: AgentEvent[];
  statuses: Array<[RunStatus, number | null]>;
  dones: RunStatus[];
  errors: string[];
  terminals: number;
}

function recorder(): Recorder {
  const rec: Recorder = {
    steps: [],
    statuses: [],
    dones: [],
    errors: [],
    terminals: 0,
    onStep(ev) {
      rec.steps.push(ev);
    },
    onStatus(status, position) {
      rec.statuses.push([status, position]);
    },
    onDone(status) {
      rec.dones.push(status);
    },
    onError(message) {
      rec.errors.push(message);
    },
    onTerminal() {
      rec.terminals += 1;
    },
  };
  return rec;
}

/** 用合成 ReadableStream 模拟网络分片，避免依赖真实网络。 */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function stepFrame(seq: number, runId = 'r1'): string {
  return encodeSse({
    event: 'step',
    data: { runId, seq, type: 'think', payload: { text: `s${seq}` }, ts: 1000 + seq },
  } satisfies SseMessage);
}

function statusFrame(status: RunStatus, extra: Record<string, unknown> = {}): string {
  return encodeSse({
    event: 'status',
    data: { runId: 'r1', status, ...extra },
  } satisfies SseMessage);
}

const doneFrame = encodeSse({ event: 'done', data: { runId: 'r1' } } satisfies SseMessage);
const errorFrame = encodeSse({
  event: 'error',
  data: { message: '上游连接中断' },
} satisfies SseMessage);

async function consume(
  chunks: string[],
  st: RunStreamState = createRunStreamState(),
  rec: Recorder = recorder(),
): Promise<{ st: RunStreamState; rec: Recorder }> {
  await consumeRunStream(streamResponse(chunks), st, rec);
  return { st, rec };
}

describe('applyRunStreamMessage / consumeRunStream', () => {
  it('跨分片的 step 也能更新 runId/lastSeq 并逐条回调', async () => {
    const frame1 = stepFrame(3);
    const frame2 = stepFrame(9);
    // 在第二帧中间切开：解析器必须自己拼接跨分片的半个帧。
    const cut = frame2.indexOf('"seq"') + 2;
    const { st, rec } = await consume([frame1 + frame2.slice(0, cut), frame2.slice(cut)]);

    expect(st.runId).toBe('r1');
    expect(st.lastSeq).toBe(9);
    expect(rec.steps.map((e) => e.seq)).toEqual([3, 9]);
    expect(rec.terminals).toBe(0);
  });

  it('queued 状态透传数值 position', async () => {
    const { st, rec } = await consume([statusFrame('queued', { position: 2 })]);

    expect(rec.statuses).toEqual([['queued', 2]]);
    expect(st.lastStatus).toBe('queued');
    expect(st.terminal).toBe(false);
  });

  it('running 状态下 position 恒为 null', async () => {
    const { rec } = await consume([statusFrame('running', { position: 5 })]);

    expect(rec.statuses).toEqual([['running', null]]);
  });

  it('status(canceled) 后补 done：保留取消状态且只终结一次', async () => {
    const { st, rec } = await consume([statusFrame('canceled'), doneFrame]);

    expect(rec.statuses).toEqual([['canceled', null]]);
    expect(rec.dones).toEqual(['canceled']);
    expect(st.lastStatus).toBe('canceled');
    expect(st.terminal).toBe(true);
    expect(rec.terminals).toBe(1);
  });

  it('error 帧提取 message 并进入终态', async () => {
    const { st, rec } = await consume([errorFrame]);

    expect(rec.errors).toEqual(['上游连接中断']);
    expect(st.terminal).toBe(true);
    expect(rec.terminals).toBe(1);
  });

  it('没有前置 status 的 done 归一为 done', async () => {
    const { rec } = await consume([doneFrame]);

    expect(rec.dones).toEqual(['done']);
    expect(rec.terminals).toBe(1);
  });

  it('重复终态帧不会重复触发 onTerminal', async () => {
    const st = createRunStreamState();
    const rec = recorder();
    applyRunStreamMessage(
      { event: 'status', data: { runId: 'r1', status: 'canceled' } },
      st,
      rec,
    );
    applyRunStreamMessage({ event: 'done', data: { runId: 'r1' } }, st, rec);
    applyRunStreamMessage({ event: 'done', data: { runId: 'r1' } }, st, rec);
    applyRunStreamMessage({ event: 'error', data: { message: 'late' } }, st, rec);

    expect(st.terminal).toBe(true);
    expect(rec.terminals).toBe(1);
  });

  it('响应没有 body 时抛错，调用方可据此提示断线', async () => {
    await expect(
      consumeRunStream(new Response(null, { status: 200 }), createRunStreamState(), recorder()),
    ).rejects.toThrow('no body');
  });
});
