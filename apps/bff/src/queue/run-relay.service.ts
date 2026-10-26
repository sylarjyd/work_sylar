import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { encodeSse, type AgentEvent, type SseMessage } from '@ai-office/shared';
import { TasksService } from '../tasks/tasks.service';
import { writeHead } from '../stream/sse-proxy';
import { RUN_EVENT_BUS } from './queue.tokens';
import type { RunEventBus } from './run-event-bus';
import { relayErrorPayload, runErrorMessage } from './run-errors';

/** SSE 心跳：中间层通常在 30–60s 空闲后断开，15s 一次足以保活。 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** 慢客户端暂停期间允许积压的最大消息数；超过即主动断开，避免无界内存增长。 */
export const MAX_PENDING_MESSAGES = 1000;

/** 慢客户端暂停期间 socket 缓冲的字节上限，超过即主动断开。 */
export const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/**
 * SSE 转发器：把一次运行的落库步骤与实时事件拼成一条可重连的流。
 *
 * 挂接顺序是「先订阅、再回放、后实时」：若先回放再订阅，两步之间产生的事件
 * 会永久丢失；先订阅则回放窗口内的事件先进入缓冲区，回放结束后按 seq 去重补发。
 */
@Injectable()
export class RunRelayService {
  private readonly logger = new Logger(RunRelayService.name);

  constructor(
    private readonly tasks: TasksService,
    @Inject(RUN_EVENT_BUS) private readonly events: RunEventBus,
  ) {}

  /**
   * 挂接一条 SSE 流：先订阅（避免回放窗口丢事件）→ 回放 DB → 冲缓冲 → 转发实时。
   * 返回的 Promise 在流终结（done/error/canceled 或客户端断开）时 resolve。
   */
  async attach(
    runId: string,
    reply: FastifyReply,
    opts: { afterSeq?: number } = {},
  ): Promise<void> {
    const afterSeq = opts.afterSeq ?? -1;
    // 归属已由控制器先行校验；run 被并发删除时按 404 抛出，此时尚未 hijack。
    const run = await this.tasks.findRun(runId);

    // 接管回复：之后由本服务直接写 socket，Nest/Fastify 不再自动发送。
    reply.hijack();
    writeHead(reply, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let finalized = false;
    /** 回放结束前收到的实时事件先入缓冲，保证不丢且顺序正确。 */
    let live = false;
    let lastSeq = afterSeq;
    let heartbeat: NodeJS.Timeout | undefined;
    let off: (() => void) | undefined;
    const buffered: SseMessage[] = [];
    /** socket 写满后暂停；暂停期间非终态消息进入 pending，保持原有顺序。 */
    let paused = false;
    const pending: SseMessage[] = [];
    let drainHandler: (() => void) | undefined;

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    const clearHeartbeat = (): void => {
      if (!heartbeat) return;
      clearInterval(heartbeat);
      heartbeat = undefined;
    };

    const detach = (): void => {
      clearHeartbeat();
      const fn = off;
      off = undefined;
      if (!fn) return;
      try {
        // Redis 实现的 off 是异步函数；其 rejection 不能逃逸成未处理异常。
        void Promise.resolve(fn()).catch(() => undefined);
      } catch {
        // 退订失败无需影响连接收尾。
      }
    };

    const clearPending = (): void => {
      pending.length = 0;
    };

    const settle = (endStream: boolean): void => {
      // 收尾只做一次：实时终止事件与客户端 close 可能先后到达。
      if (finalized) return;
      finalized = true;
      clearPending();
      if (drainHandler) {
        reply.raw.off('drain', drainHandler);
        drainHandler = undefined;
      }
      paused = false;
      detach();
      if (endStream) {
        try {
          reply.raw.end();
        } catch {
          // 客户端已断开时 end() 可能抛错，忽略。
        }
      }
      resolveSettled();
    };

    /** 真正写 socket；返回 false 表示内核/用户态缓冲已满，需要暂停生产。 */
    const writeRaw = (msg: SseMessage): boolean => {
      try {
        return reply.raw.write(encodeSse(msg));
      } catch {
        // 客户端已断开；close 处理器会负责退订与清理。
        return true;
      }
    };

    const flushPending = (): void => {
      while (!finalized && pending.length > 0) {
        const msg = pending.shift()!;
        if (!writeRaw(msg)) {
          startPause();
          return;
        }
      }
    };

    const startPause = (): void => {
      if (paused || finalized) return;
      paused = true;
      drainHandler = () => {
        drainHandler = undefined;
        paused = false;
        flushPending();
      };
      reply.raw.once('drain', drainHandler);
    };

    const enqueue = (msg: SseMessage): void => {
      pending.push(msg);
      // 慢客户端积压超过上限时，继续缓冲会无限占用进程内存（工具结果可能很大）。
      // 主动断开优于 OOM：客户端会带 afterSeq 重连，由 DB 回放补齐历史。
      if (
        pending.length > MAX_PENDING_MESSAGES ||
        reply.raw.writableLength > MAX_PENDING_BYTES
      ) {
        settle(true);
      }
    };

    /**
     * 所有出站帧的唯一入口：统一做 checkpoint 过滤、收尾抑制与背压排队。
     * force 用于终态帧：即使 socket 已饱和也必须写出，否则客户端会永久挂起。
     */
    const write = (msg: SseMessage, force = false): void => {
      // checkpoint 是 BFF 内部续跑事件，不下发浏览器；收尾后不再写。
      if (finalized || msg.event === 'checkpoint') return;
      if (paused && !force) {
        enqueue(msg);
        return;
      }
      if (!writeRaw(msg)) startPause();
    };

    /** 写入一条实时事件；收到终止事件时立即收尾并返回 true。 */
    const forward = (msg: SseMessage): boolean => {
      if (msg.event === 'step') {
        const seq = (msg.data as { seq?: unknown }).seq;
        // 回放已覆盖的序号直接跳过，避免重连后重复步骤。
        if (typeof seq === 'number') {
          if (seq <= lastSeq) return false;
          lastSeq = seq;
        }
      }
      const data = msg.data as { status?: unknown } | null;
      const canceled = msg.event === 'status' && data?.status === 'canceled';
      const terminal = canceled || msg.event === 'done' || msg.event === 'error';
      if (terminal) {
        // 终态帧必须送达（暂停中也强制写）；排队中的非终态消息直接丢弃，
        // 客户端重连后会通过 afterSeq 从 DB 回放补齐。
        clearPending();
      }
      write(msg, terminal);
      // 取消是终态，但实时路径没有 done 帧；必须补发，前端才能正常结束流。
      if (canceled) {
        write({ event: 'done', data: { runId } }, true);
        settle(true);
        return true;
      }
      if (msg.event === 'done' || msg.event === 'error') {
        settle(true);
        return true;
      }
      return false;
    };

    // 客户端断开（或 socket 出错）时停止转发并释放订阅/心跳；error 必须监听，否则会崩进程。
    const onClientGone = (): void => settle(false);
    reply.raw.on('close', onClientGone);
    reply.raw.on('error', onClientGone);

    try {
      off = await this.events.subscribe(runId, (msg) => {
        if (finalized) return;
        if (!live) {
          buffered.push(msg);
          return;
        }
        forward(msg);
      });
    } catch (err) {
      this.logger.error(`run ${runId} 订阅实时事件失败: ${(err as Error).message}`);
      write({ event: 'error', data: relayErrorPayload('event_bus_unavailable') }, true);
      settle(true);
      return settled;
    }

    // 订阅等待期间客户端可能已断开：拿到 off 后立即释放，不能再回放。
    if (finalized) {
      detach();
      return settled;
    }

    // 回放已落库步骤；失败时无法继续保证前端拿到完整历史，写 error 帧结束。
    try {
      const steps = await this.tasks.listSteps(runId, afterSeq);
      for (const ev of steps) {
        if (finalized) return settled;
        lastSeq = Math.max(lastSeq, ev.seq);
        write({ event: 'step', data: ev });
      }
    } catch (err) {
      this.logger.error(`run ${runId} 回放步骤失败: ${(err as Error).message}`);
      write({ event: 'error', data: relayErrorPayload('steps_unavailable') }, true);
      settle(true);
      return settled;
    }

    // 回放完成：切到实时并冲缓冲，期间产生的重复步骤会被 lastSeq 过滤。
    live = true;
    for (const msg of buffered) {
      if (forward(msg)) {
        buffered.length = 0;
        return settled;
      }
    }
    buffered.length = 0;

    // 回放期间运行可能已经终结（缓冲中已处理则此处跳过）。
    if (finalized) return settled;

    // 订阅已生效、回放与缓冲都冲齐后再重读 run：首次快照可能已过期。
    // 运行状态先于终态事件落库，因此此处的读值是权威的；若终态事件在订阅后
    // 才发布，它会实时送达并已收尾（上面的 finalized 检查会拦下）。DB 抖动时
    // 沿用首次快照，避免把瞬时故障变成断流。
    let status = run.status;
    let lastError = run.lastError;
    try {
      const latest = await this.tasks.findRun(runId);
      status = latest.status;
      lastError = latest.lastError;
    } catch (err) {
      this.logger.warn(
        `run ${runId} 重读状态失败，沿用首次快照: ${(err as Error).message}`,
      );
    }
    // 重读等待期间实时终态事件可能已经收尾。
    if (finalized) return settled;

    if (status === 'done') {
      forward({ event: 'done', data: { runId } });
    } else if (status === 'failed') {
      forward({ event: 'error', data: runErrorMessage(lastError) });
    } else if (status === 'canceled') {
      // 终态帧：即使 socket 已饱和也必须写出，否则前端拿不到取消状态。
      write({ event: 'status', data: { runId, status: 'canceled' } }, true);
      forward({ event: 'done', data: { runId } });
    } else {
      // queued/running：先告知当前状态，再靠心跳与实时事件维持长连接。
      write({ event: 'status', data: { runId, status } });
      heartbeat = setInterval(() => {
        // socket 已饱和时跳过心跳：继续写只会让缓冲继续膨胀。
        if (finalized || paused) return;
        try {
          reply.raw.write(': ping\n\n');
        } catch {
          // 客户端已断开；close 处理器会清理定时器。
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
    }

    return settled;
  }
}
