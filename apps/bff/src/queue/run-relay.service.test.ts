import 'reflect-metadata';
import { Logger } from '@nestjs/common';
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
import { MAX_PENDING_MESSAGES, RunRelayService } from './run-relay.service';
import { errorPayload, relayErrorPayload } from './run-errors';

/** 一条落库步骤（模拟 Prisma 还原后的 AgentEvent）。 */
function stepRow(seq: number): AgentEvent {
  return { runId: 'r1', seq, type: 'think', payload: { text: `s${seq}` }, ts: 1000 + seq };
}

/** 一条实时步骤事件。 */
function stepEvent(seq: number): AgentEvent {
  return stepRow(seq);
}

interface FakeRun {
  id: string;
  status: string;
  lastError: string | null;
  taskId: string;
  tenantId: string;
}

/** 默认字段贴合 findRun 的真实返回，个别用例只覆盖关心的字段。 */
function fakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return { id: 'r1', status: 'running', lastError: null, taskId: 'task1', tenantId: 't1', ...overrides };
}

interface FakeRaw extends EventEmitter {
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writableLength: number;
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
  raw.writableLength = 0;
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
  /** 覆盖 run 读取，用于制造「首次快照与订阅后状态不一致」的竞态。 */
  findRun?: (runId: string) => Promise<FakeRun>;
  /** countQueued 的返回值；也给成 Error 模拟统计失败。 */
  queuedPosition?: number | Error;
}

interface RelayDeps {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  listSteps: ReturnType<typeof vi.fn>;
  countQueued: ReturnType<typeof vi.fn>;
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
  const countQueued = vi.fn(async () => {
    if (options.queuedPosition instanceof Error) throw options.queuedPosition;
    return options.queuedPosition ?? 0;
  });
  const tasks = {
    findRun: vi.fn(
      options.findRun ??
        (async (): Promise<FakeRun> =>
          fakeRun({ status: options.status ?? 'running', lastError: options.lastError ?? null })),
    ),
    listSteps,
    countQueued,
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
      countQueued,
      emit: (msg) => handler?.(msg),
    },
  };
}

/** 让下一次 write 仍记录帧但返回 false，模拟 socket 缓冲区写满。 */
function backpressureOnce(raw: FakeRaw, chunks: string[]): void {
  raw.write.mockImplementationOnce((chunk: string) => {
    chunks.push(chunk);
    return false;
  });
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

  it('queued 状态附带同租户前方等待数', async () => {
    const { relay, deps } = makeRelay({ status: 'queued', queuedPosition: 3 });
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    // 统计入口排除运行自身所属任务，前端看到的就是「前方」而非含自己的位次。
    expect(deps.countQueued).toHaveBeenCalledWith('t1', 'task1');
    expect(messages(chunks)).toEqual([
      { event: 'status', data: { runId: 'r1', status: 'queued', position: 3 } },
    ]);

    reply.raw.emit('close');
    await done;
  });

  it('排队位次统计失败时省略 position 字段', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { relay } = makeRelay({ status: 'queued', queuedPosition: new Error('db down') });
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    const status = messages(chunks).find((m) => m.event === 'status');
    expect(status).toEqual({ event: 'status', data: { runId: 'r1', status: 'queued' } });
    // 必须完全没有 position 键：显式 undefined 也会被 JSON.stringify 丢掉，但键存在时语义不同。
    expect(status?.data).not.toHaveProperty('position');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    reply.raw.emit('close');
    await done;
  });

  it('排队位次统计期间运行终结：不启动心跳也不补发状态帧', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { relay, deps } = makeRelay({ status: 'queued', queuedPosition: 0 });
    let release!: (n: number) => void;
    deps.countQueued.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const { reply, chunks } = fakeReply();
    const done = relay.attach('r1', reply);
    await vi.waitFor(() => expect(deps.countQueued).toHaveBeenCalled());

    // 统计尚未返回时取消事件先到：forward 已收尾，await 返回后必须立即退出。
    // 少了 finalized 复查虽然写帧会被 write 拦下，但会在已 settle 的流上留下没人清理的心跳。
    deps.emit({ event: 'status', data: { runId: 'r1', status: 'canceled' } });
    release(2);
    await done;

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    expect(messages(chunks)).toEqual([
      { event: 'status', data: { runId: 'r1', status: 'canceled' } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
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
      { event: 'error', data: relayErrorPayload('event_bus_unavailable') },
    ]);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('订阅后重读 run 状态，回放窗口内终结时不悬挂', async () => {
    let calls = 0;
    const findRun = vi.fn(async (): Promise<FakeRun> => {
      calls += 1;
      return calls === 1
        ? fakeRun({ status: 'running' })
        : fakeRun({ status: 'done' });
    });
    const { relay, deps } = makeRelay({ findRun });
    const { reply, chunks } = fakeReply();

    // 首次快照是 running，但订阅后（无实时终态事件）重读为 done。
    // 修复前会进入心跳分支，attach 永不 resolve。
    await relay.attach('r1', reply);

    expect(findRun).toHaveBeenCalledTimes(2);
    expect(messages(chunks)).toEqual([{ event: 'done', data: { runId: 'r1' } }]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('重读 run 为 failed 时补发 error 帧并结束，不进入心跳', async () => {
    let calls = 0;
    const findRun = vi.fn(async (): Promise<FakeRun> => {
      calls += 1;
      return calls === 1
        ? fakeRun({ status: 'running' })
        : fakeRun({ status: 'failed', lastError: 'insufficient_credits' });
    });
    const { relay, deps } = makeRelay({ findRun });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([
      { event: 'error', data: errorPayload('insufficient_credits') },
    ]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('重读 run 失败时沿用首次快照，不中断流', async () => {
    let calls = 0;
    const findRun = vi.fn(async (): Promise<FakeRun> => {
      calls += 1;
      if (calls === 1) return fakeRun({ status: 'done' });
      throw new Error('db blip');
    });
    const { relay, deps } = makeRelay({ findRun });
    const { reply, chunks } = fakeReply();

    await relay.attach('r1', reply);

    expect(messages(chunks)).toEqual([{ event: 'done', data: { runId: 'r1' } }]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('写返回 false 后暂停，实时消息排队并在 drain 后按序补发', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, raw, chunks } = fakeReply();
    // 首帧（status）写入即触发背压：socket 缓冲区已满。
    backpressureOnce(raw, chunks);
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    deps.emit({ event: 'step', data: stepEvent(1) });
    deps.emit({ event: 'step', data: stepEvent(2) });
    // 暂停期间不得继续写 socket，消息只进排队。
    expect(writtenSeqs(chunks)).toEqual([]);

    raw.emit('drain');
    await vi.waitFor(() => expect(writtenSeqs(chunks)).toEqual([1, 2]));

    deps.emit({ event: 'done', data: { runId: 'r1' } });
    await done;
    expect(writtenSeqs(chunks)).toEqual([1, 2]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('慢客户端积压超过上限时主动断开，交由客户端带 afterSeq 重连', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, raw, chunks } = fakeReply();
    backpressureOnce(raw, chunks);
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    // 第 MAX_PENDING_MESSAGES + 1 条排队消息触发上限。
    for (let seq = 0; seq <= MAX_PENDING_MESSAGES; seq += 1) {
      deps.emit({ event: 'step', data: stepEvent(seq) });
    }

    await done;
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('待发字节数超过上限时主动断开，消息条数未超限也生效', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, raw, chunks } = fakeReply();
    backpressureOnce(raw, chunks);
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    // 单帧约 3MiB；三条即超过 8MiB 字节上限，但远未触及消息条数上限。
    // 暂停期间 writableLength 冻结，若不按入队帧累计字节数判断，这里不会断开。
    const blob = 'x'.repeat(3 * 1024 * 1024);
    for (let seq = 0; seq < 3; seq += 1) {
      deps.emit({
        event: 'step',
        data: { runId: 'r1', seq, type: 'think', payload: { text: blob }, ts: 1000 + seq },
      });
    }

    await done;
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('暂停期间收到实时 canceled 时强制写出并结束流', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, raw, chunks } = fakeReply();
    backpressureOnce(raw, chunks);
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    deps.emit({ event: 'step', data: stepEvent(1) }); // 暂停中排队，终态到达后被丢弃
    deps.emit({ event: 'status', data: { runId: 'r1', status: 'canceled' } });
    await done;

    expect(messages(chunks)).toEqual([
      { event: 'status', data: { runId: 'r1', status: 'running' } },
      { event: 'status', data: { runId: 'r1', status: 'canceled' } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('暂停期间收到 done 时强制写出终态，不被积压吞掉', async () => {
    const { relay, deps } = makeRelay({ status: 'running' });
    const { reply, raw, chunks } = fakeReply();
    backpressureOnce(raw, chunks);
    const done = relay.attach('r1', reply);
    await untilEvent(chunks, 'status');

    deps.emit({ event: 'step', data: stepEvent(1) }); // 暂停中排队
    deps.emit({ event: 'done', data: { runId: 'r1' } });
    await done;

    // 排队的非终态步骤被丢弃（客户端重连后从 DB 补齐），done 必须送达。
    expect(messages(chunks)).toEqual([
      { event: 'status', data: { runId: 'r1', status: 'running' } },
      { event: 'done', data: { runId: 'r1' } },
    ]);
    expect(reply.raw.end).toHaveBeenCalled();
  });
});
