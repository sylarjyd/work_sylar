import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { encodeSse, type AgentEvent, type SseMessage } from '@ai-office/shared';
import { TasksService } from '../tasks/tasks.service';
import { writeHead } from '../stream/sse-proxy';
import { RUN_EVENT_BUS } from './queue.tokens';
import type { RunEventBus } from './run-event-bus';

/** SSE 心跳：中间层通常在 30–60s 空闲后断开，15s 一次足以保活。 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const RUN_FAILED_MESSAGE = '本次运行失败，请稍后重试';

/** 把 task.lastError 归一为前端可展示的 error 负载；机器码统一转中文。 */
function failedPayload(lastError: string | null): { message: string; error: 'run_failed' } {
  return {
    message: lastError && lastError !== 'run_failed' ? lastError : RUN_FAILED_MESSAGE,
    error: 'run_failed',
  };
}

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

    const settle = (endStream: boolean): void => {
      // 收尾只做一次：实时终止事件与客户端 close 可能先后到达。
      if (finalized) return;
      finalized = true;
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

    const write = (msg: SseMessage): void => {
      // checkpoint 是 BFF 内部续跑事件，不下发浏览器；收尾后不再写。
      if (finalized || msg.event === 'checkpoint') return;
      try {
        reply.raw.write(encodeSse(msg));
      } catch {
        // 客户端已断开；close 处理器会负责退订与清理。
      }
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
      write(msg);
      const data = msg.data as { status?: unknown } | null;
      const terminal =
        msg.event === 'done' ||
        msg.event === 'error' ||
        (msg.event === 'status' && data?.status === 'canceled');
      if (terminal) {
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
      write({
        event: 'error',
        data: { message: '事件订阅失败，请重试', error: 'event_bus_unavailable' },
      });
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
      write({
        event: 'error',
        data: { message: '历史步骤读取失败，请重试', error: 'steps_unavailable' },
      });
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
    if (run.status === 'done') {
      forward({ event: 'done', data: { runId } });
    } else if (run.status === 'failed') {
      forward({ event: 'error', data: failedPayload(run.lastError) });
    } else if (run.status === 'canceled') {
      write({ event: 'status', data: { runId, status: 'canceled' } });
      forward({ event: 'done', data: { runId } });
    } else {
      // queued/running：先告知当前状态，再靠心跳与实时事件维持长连接。
      write({ event: 'status', data: { runId, status: run.status } });
      heartbeat = setInterval(() => {
        if (finalized) return;
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
