import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import {
  decodeSseFrames,
  type AgentEvent,
  type SseMessage,
} from '@ai-office/shared';
import type { TasksService } from '../tasks/tasks.service';
import type { RunEventBus } from './run-event-bus';
import { RunRelayService } from './run-relay.service';

/** 一条落库步骤（模拟 Prisma 还原后的 AgentEvent）。 */
function stepRow(seq: number): AgentEvent {
  return { runId: 'r1', seq, type: 'think', payload: { text: `s${seq}` }, ts: 1000 + seq };
}

/** 一条实时步骤事件。 */
function stepEvent(seq: number): AgentEvent {
  return stepRow(seq);
}

interface FakeRaw extends EventEmitter {
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

interface FakeReply {
  reply: FastifyReply;
  raw: FakeRaw;
  chunks: string[];
}

function fakeReply(): FakeReply {
  const chunks: string[] = [];
  const raw = new EventEmitter() as FakeRaw;
  raw.writeHead = vi.fn();
  raw.write = vi.fn((chunk: string) => {
    chunks.push(chunk);
    return true;
  });
  raw.end = vi.fn();
  const reply = {
    raw,
    hijack: vi.fn(),
    getHeaders: () => ({}),
  } as unknown as FastifyReply;
  return { reply, raw, chunks };
}

interface RelayOptions {
  steps?: AgentEvent[];
  status?: string;
  lastError?: string | null;
  subscribeError?: Error;
  /** 覆盖回放实现，用于制造「回放尚未完成」的时序。 */
  listSteps?: (runId: string, afterSeq: number) => Promise<AgentEvent[]>;
}

interface RelayDeps {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  listSteps: ReturnType<typeof vi.fn>;
  emit: (msg: SseMessage) => void;
}

/** 直接 new 转发器并注入假任务服务与假总线，不依赖 Nest/Redis/DB。 */
function makeRelay(options: RelayOptions = {}): { relay: RunRelayService; deps: RelayDeps } {
  let handler: ((msg: SseMessage) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    handler = null;
  });
  const subscribe = vi.fn(
    async (_runId: string, h: (msg: SseMessage) => void): Promise<() => void> => {
      if (options.subscribeError) throw options.subscribeError;
      handler = h;
      return unsubscribe;
    },
  );
  const steps = options.steps ?? [];
  const listSteps = vi.fn(
    options.listSteps ??
      (async (_runId: string, afterSeq: number): Promise<AgentEvent[]> =>
        steps.filter((s) => s.seq > afterSeq)),
  );
  const tasks = {
    findRun: vi.fn().mockResolvedValue({
      id: 'r1',
      status: options.status ?? 'running',
      lastError: options.lastError ?? null,
    }),
    listSteps,
  };
  const events = { publish: vi.fn().mockResolvedValue(undefined), subscribe };
  const relay = new RunRelayService(
    tasks as unknown as TasksService,
    events as unknown as RunEventBus,
  );
  return {
    relay,
    deps: {
      subscribe,
      unsubscribe,
      listSteps,
      emit: (msg) => handler?.(msg),
    },
  };
}

function messages(chunks: string[]): SseMessage[] {
  return decodeSseFrames(chunks.join(''));
}

function writtenSeqs(chunks: string[]): number[] {
  return messages(chunks)
    .filter((m) => m.event === 'step')
    .map((m) => (m.data as AgentEvent).seq);
}

async function untilSubscribed(deps: RelayDeps): Promise<void> {
  await vi.waitFor(() => expect(deps.subscribe).toHaveBeenCalled());
}

async function untilEvent(chunks: string[], event: string): Promise<void> {
  await vi.waitFor(() =>
    expect(messages(chunks).some((m) => m.event === event)).toBe(true),
  );
}

describe('RunRelayService', () => {
  it('先回放 DB 步骤再转发实时事件，且按 seq 去重', async () => {
    const { relay, deps } = makeRelay({ steps: [stepRow(0), stepRow(1)], status: 'running' });
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply, { afterSeq: -1 });
    await untilSubscribed(deps);
    deps.emit({ event: 'step', data: stepEvent(1) }); // 已回放：跳过
    deps.emit({ event: 'step', data: stepEvent(2) }); // 新增
    deps.emit({ event: 'done', data: { runId: 'r1' } });
    await done;

    expect(writtenSeqs(chunks)).toEqual([0, 1, 2]);
    expect(messages(chunks).filter((m) => m.event === 'done')).toEqual([
      { event: 'done', data: { runId: 'r1' } },
    ]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('终态 run 回放后直接结束', async () => {
    const { relay, deps } = makeRelay({
      steps: [stepRow(0)],
      status: 'failed',
      lastError: 'boom',
    });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
    expect(messages(chunks)).toEqual([
      { event: 'step', data: stepRow(0) },
      { event: 'error', data: { message: '本次运行失败，请稍后重试', error: 'run_failed' } },
    ]);
  });

  it('failed 终态：机器码 run_failed 转为中文提示', async () => {
    const { relay } = makeRelay({ status: 'failed', lastError: 'run_failed' });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      { event: 'error', data: { message: '本次运行失败，请稍后重试', error: 'run_failed' } },
    ]);
  });

  it('failed 终态：未知机器码归一为 run_failed 中文提示', async () => {
    const { relay } = makeRelay({ status: 'failed', lastError: 'worker_lost' });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      { event: 'error', data: { message: '本次运行失败，请稍后重试', error: 'run_failed' } },
    ]);
  });

  it('failed 终态：已知机器码透出对应中文与 code', async () => {
    const { relay } = makeRelay({ status: 'failed', lastError: 'insufficient_credits' });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      { event: 'error', data: { message: '积分不足，请充值后重试', error: 'insufficient_credits' } },
    ]);
  });

  it('failed 终态：lastError 为空时用通用中文提示', async () => {
    const { relay } = makeRelay({ status: 'failed', lastError: null });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      { event: 'error', data: { message: '本次运行失败，请稍后重试', error: 'run_failed' } },
    ]);
  });

  it('实时 status(canceled) 补发 done 收尾，迟到的 done 被忽略', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    deps.emit({ event: 'status', data: { runId: 'r1', status: 'canceled' } });
    await done;

    expect(messages(chunks)).toEqual([
      { event: 'status', data: { runId: 'r1', status: 'running' } },
      { event: 'status', data: { runId: 'r1', status: 'canceled' } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();

    // 真实 done 迟到时流已收尾，不能再写第二帧 done。
    deps.emit({ event: 'done', data: { runId: 'r1' } });
    expect(messages(chunks).filter((m) => m.event === 'done')).toHaveLength(1);
  });

  it('canceled 终态输出 status(canceled) 后补 done', async () => {
    const { relay } = makeRelay({ steps: [stepRow(0)], status: 'canceled' });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      { event: 'step', data: stepRow(0) },
      { event: 'status', data: { runId: 'r1', status: 'canceled' } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
  });

  it('checkpoint 事件被过滤，不下发浏览器', async () => {
    const { relay, deps } = makeRelay({ steps: [stepRow(0)], status: 'running' });
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    deps.emit({ event: 'checkpoint', data: { round: 1, seq: 1 } });
    deps.emit({ event: 'done', data: { runId: 'r1' } });
    await done;

    expect(messages(chunks).map((m) => m.event)).toEqual(['step', 'status', 'done']);
  });

  it('afterSeq 过滤已回放步骤并透传给回放查询', async () => {
    const { relay, deps } = makeRelay({
      steps: [stepRow(0), stepRow(1), stepRow(2)],
      status: 'done',
    });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply, { afterSeq: 0 });

    expect(deps.listSteps).toHaveBeenCalledWith('r1', 0);
    expect(writtenSeqs(chunks)).toEqual([1, 2]);
  });

  it('实时事件先于回放完成时被缓冲，回放后按序补发不丢', async () => {
    let resolveSteps!: (steps: AgentEvent[]) => void;
    const pending = new Promise<AgentEvent[]>((resolve) => {
      resolveSteps = resolve;
    });
    const { relay, deps } = makeRelay({
      status: 'running',
      listSteps: () => pending,
    });
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply, { afterSeq: -1 });
    await untilSubscribed(deps);

    // 回放尚未完成：这两条必须先缓冲，待回放结束后再按序处理。
    deps.emit({ event: 'step', data: stepEvent(2) });
    deps.emit({ event: 'step', data: stepEvent(1) });
    resolveSteps([stepRow(0), stepRow(1)]);
    await untilEvent(chunks, 'status');

    expect(writtenSeqs(chunks)).toEqual([0, 1, 2]);

    deps.emit({ event: 'done', data: { runId: 'r1' } });
    await done;
    expect(writtenSeqs(chunks)).toEqual([0, 1, 2]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('客户端 close 后退订并清理心跳，不再写响应', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, raw, chunks } = fakeReply();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    raw.emit('close');
    await done;

    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(reply.raw.end).not.toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('订阅失败时写 error 帧并结束，不留悬挂连接', async () => {
    const { relay } = makeRelay({ subscribeError: new Error('redis down') });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      {
        event: 'error',
        data: { message: '事件订阅失败，请重试', error: 'event_bus_unavailable' },
      },
    ]);
    expect(reply.raw.end).toHaveBeenCalled();
  });
});
