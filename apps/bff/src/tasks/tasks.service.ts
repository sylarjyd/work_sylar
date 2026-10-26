import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  attachmentKindFor,
  type AgentEvent,
  type RunCheckpointEvent,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { SessionsService, type SessionRef } from '../sessions/sessions.service';
import type { PreparedAttachment, PreparedMessage } from '../attachments/attachments.service';
import type { RunSnapshot } from '../queue/run-job';

/** 并发抢占同一 seq 时的最大尝试次数（首次 + 最多 4 次重试）。 */
const MAX_SEQ_ATTEMPTS = 5;

/** 仅当唯一键冲突落在 seq 上时才值得重试；runId 等主键冲突重试也不会成功。 */
function isSeqConflict(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const t = e.meta?.target;
  if (Array.isArray(t)) return t.includes('seq');
  if (typeof t === 'string') return t.includes('seq');
  // 老版本/未提供 target 时保守重试。
  return true;
}

/** 行里的 kind 是历史写入值；旧数据缺类别时按文件名/MIME 重新推断，默认按文本处理。 */
function toPreparedAttachment(row: {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  storageKey: string;
}): PreparedAttachment {
  return {
    id: row.id,
    kind: attachmentKindFor(row.filename, row.mime) ?? 'text',
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    storageKey: row.storageKey,
  };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** 只为归属校验：让控制器能在计费预占之前先做 404 判断，并拿到会话模型与助手配置。 */
  async assertOwned(
    sessionId: string,
    tenantId: string,
    userId: string,
  ): Promise<SessionRef> {
    return this.sessions.assertOwned(sessionId, tenantId, userId);
  }

  /**
   * 建 task/run、落用户消息、绑定附件，并把喂给模型的完整历史补进入队快照。
   * runId 由控制器预生成（队列作业键）；附件在事务内原子认领，并发重复发送只会有一次成功。
   */
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
    runId: string,
    traceId: string | null,
    attachmentIds: string[],
    snapshot: RunSnapshot,
  ): Promise<{ taskId: string; runId: string; tenantId: string; userId: string }> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);
    const ids = [...new Set(attachmentIds)];

    // 并发请求会同时读到相同的 max(seq)，进而撞 (sessionId, seq) 唯一键。
    // 整段放进同一事务：重试时前一次的 task/run 已回滚，不会留下孤儿。
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const prior = await tx.message.findMany({
            where: { sessionId },
            orderBy: { seq: 'asc' },
            select: {
              role: true,
              content: true,
              seq: true,
              attachments: {
                select: {
                  id: true,
                  kind: true,
                  filename: true,
                  mime: true,
                  size: true,
                  storageKey: true,
                },
              },
            },
          });
          const task = await tx.task.create({
            data: {
              sessionId,
              goal,
              status: 'queued',
              input: snapshot as unknown as Prisma.InputJsonValue,
            },
          });
          const run = await tx.run.create({
            // startedAt 由执行器在真正开始执行时写入。
            data: {
              id: runId,
              taskId: task.id,
              status: 'queued',
              traceId: traceId ?? null,
            },
          });
          // 用当前最大 seq + 1 而不是长度：历史消息删除后 seq 会有空洞。
          const nextSeq = prior.length > 0 ? prior[prior.length - 1].seq + 1 : 0;
          const message = await tx.message.create({
            data: { sessionId, role: 'user', content: goal, seq: nextSeq },
          });

          // 认领条件同时校验归属与「未被占用」：别人或已发送的附件都认领不到，
          // 数量不符即回滚，避免消息与附件部分绑定。重试时上一次绑定已随事务回滚。
          let current: PreparedAttachment[] = [];
          if (ids.length > 0) {
            const claimed = await tx.attachment.updateMany({
              where: {
                id: { in: ids },
                tenantId,
                userId,
                sessionId: null,
                messageId: null,
              },
              data: { sessionId, messageId: message.id },
            });
            if (claimed.count !== ids.length) throw new NotFoundException('attachment_not_found');
            const rows = await tx.attachment.findMany({
              where: { messageId: message.id },
              select: {
                id: true,
                kind: true,
                filename: true,
                mime: true,
                size: true,
                storageKey: true,
              },
            });
            const byId = new Map(rows.map((r) => [r.id, r]));
            current = ids.map((id) => toPreparedAttachment(byId.get(id)!));
          }

          const messages: PreparedMessage[] = [
            ...prior.map((m) => ({
              role: m.role as PreparedMessage['role'],
              content: m.content,
              attachments: m.attachments.map(toPreparedAttachment),
            })),
            { role: 'user', content: goal, attachments: current },
          ];
          // 完整历史写回快照：执行器只读 Task.input，无需在开始执行时再查一次历史。
          await tx.task.update({
            where: { id: task.id },
            data: { input: { ...snapshot, messages } as unknown as Prisma.InputJsonValue },
          });
          return { taskId: task.id, runId: run.id, tenantId, userId };
        });
      } catch (err) {
        // 非 seq 唯一键冲突（如 runId 主键冲突）重试也不会成功，立即抛出。
        if (!isSeqConflict(err) || attempt >= MAX_SEQ_ATTEMPTS - 1) {
          throw err;
        }
      }
    }
  }

  /**
   * 读取入队时固化的运行快照；缺失说明入队不完整或数据被清理，执行器据此失败收尾。
   * 这里只做存在性检查，结构校验交给执行器的 parseSnapshot（避免 tasks 反向依赖执行器）。
   */
  async loadSnapshot(taskId: string): Promise<unknown> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || !task.input) throw new NotFoundException('task_snapshot_missing');
    return task.input;
  }

  /**
   * 回填历史会话的模型：只写 model 仍为空的行，首次运行成功后生效，
   * 之后即使用户切换默认模型也不会改写已有会话。
   */
  async bindModel(sessionId: string, model: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, model: null },
      data: { model },
    });
  }

  async recordStep(runId: string, ev: AgentEvent): Promise<void> {
    await this.prisma.step.create({
      data: { runId, seq: ev.seq, type: ev.type, payload: ev.payload as unknown as Prisma.InputJsonValue },
    });
  }

  /**
   * 落运行断点，每个 run 只保留一行。
   * deltas 是截至该轮的累计值，必须整行覆盖而不是追加，否则续跑会把历史回放成重复消息。
   * artifactIds 取保存当刻该 run 的全部产物：续跑截断时以此为准，删除半轮残留的产物。
   */
  async saveCheckpoint(runId: string, cp: RunCheckpointEvent): Promise<void> {
    const artifacts = await this.prisma.artifact.findMany({
      where: { runId },
      select: { id: true },
    });
    const data = {
      round: cp.round,
      seq: cp.seq,
      deltas: cp.deltas as unknown as Prisma.InputJsonValue,
      usage: cp.usage as unknown as Prisma.InputJsonValue,
      artifactIds: artifacts.map((a) => a.id) as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.runCheckpoint.upsert({
      where: { runId },
      create: { runId, ...data },
      update: data,
    });
  }

  /** 读取最近一次断点；执行器在每次尝试前重读，确保用上上一次尝试新落的断点。 */
  async getCheckpoint(runId: string) {
    return this.prisma.runCheckpoint.findUnique({ where: { runId } });
  }

  /**
   * 续跑前清理半轮状态：删除 seq >= 断点序号的步骤与不在断点产物清单里的产物。
   * Step 有 (runId, seq) 唯一键，半轮残留会让重放直接撞唯一键；产物残留会造成重复记录。
   * artifactIds 来自 JSON 列，历史/异常数据可能不是字符串数组，这里按空清单容错（宁可多删）。
   */
  async truncateForResume(
    runId: string,
    cp: { seq: number; artifactIds: unknown },
  ): Promise<void> {
    const artifactIds = Array.isArray(cp.artifactIds)
      ? cp.artifactIds.filter((id): id is string => typeof id === 'string')
      : [];
    await this.prisma.$transaction([
      this.prisma.step.deleteMany({ where: { runId, seq: { gte: cp.seq } } }),
      this.prisma.artifact.deleteMany({ where: { runId, id: { notIn: artifactIds } } }),
    ]);
  }

  /**
   * 开跑前把 run/task 从 queued 推进到 running（同一事务，避免两行状态撕裂）。
   * 重试与崩溃重投时两行可能已是 running，条件更新 0 行属于正常，不能视为故障；
   * startedAt 只在首次成功推进时写入，保留真实开始时间。
   */
  async markRunning(runId: string, taskId: string): Promise<void> {
    const startedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.run.updateMany({
        where: { id: runId, status: 'queued' },
        data: { status: 'running', startedAt },
      }),
      this.prisma.task.updateMany({
        where: { id: taskId, status: 'queued' },
        data: { status: 'running', startedAt },
      }),
    ]);
  }

  /** 流式挂接需要的运行元信息；不存在时 404。 */
  async findRun(runId: string): Promise<{
    id: string;
    status: string;
    lastError: string | null;
    cancelRequestedAt: Date | null;
  }> {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        cancelRequestedAt: true,
        task: { select: { lastError: true } },
      },
    });
    if (!run) throw new NotFoundException('run_not_found');
    return {
      id: run.id,
      status: run.status,
      lastError: run.task.lastError ?? null,
      cancelRequestedAt: run.cancelRequestedAt ?? null,
    };
  }

  /** 按 seq 回放已落库步骤；payload 原样还原为 AgentEvent。 */
  async listSteps(runId: string, afterSeq = -1): Promise<AgentEvent[]> {
    const rows = await this.prisma.step.findMany({
      where: { runId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, payload: true, ts: true },
    });
    return rows.map((r) => ({
      runId,
      seq: r.seq,
      type: r.type as AgentEvent['type'],
      payload: r.payload as unknown as Record<string, unknown>,
      ts: r.ts.getTime(),
    }));
  }

  /**
   * 单租户排队任务数：用于入队时的排队上限校验。
   * 新任务在提交前已落库为 queued，必须排除自身，否则会把自己算进上限导致永远只允许 max-1 个。
   */
  async countQueued(tenantId: string, excludeTaskId?: string): Promise<number> {
    return this.prisma.task.count({
      where: {
        status: 'queued',
        session: { tenantId },
        ...(excludeTaskId ? { id: { not: excludeTaskId } } : {}),
      },
    });
  }

  /**
   * 单租户执行中任务数：用于 worker 的租户级并发让位。
   * 崩溃重投时本作业的 Task 仍为 running，必须排除自身，否则并发为 1 时永久自锁。
   */
  async countRunning(tenantId: string, excludeTaskId?: string): Promise<number> {
    return this.prisma.task.count({
      where: {
        status: 'running',
        session: { tenantId },
        ...(excludeTaskId ? { id: { not: excludeTaskId } } : {}),
      },
    });
  }

  async finish(
    runId: string,
    taskId: string,
    status: 'done' | 'failed' | 'canceled',
    assistantText: string,
    sessionId: string,
  ): Promise<void> {
    await this.prisma.run.update({ where: { id: runId }, data: { status, endedAt: new Date() } });
    await this.prisma.task.update({ where: { id: taskId }, data: { status } });
    if (assistantText) {
      await this.appendMessage(sessionId, 'assistant', assistantText);
    }
  }

  /**
   * 写入消息：序号取当前最大 seq + 1；并发抢占同一序号时重算重试。
   * run/task 状态更新已提交，不能因这里重试而回退。
   */
  private async appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const last = await this.prisma.message.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = last ? last.seq + 1 : 0;
      try {
        await this.prisma.message.create({ data: { sessionId, role, content, seq } });
        return;
      } catch (err) {
        if (!isSeqConflict(err) || attempt >= MAX_SEQ_ATTEMPTS - 1) {
          throw err;
        }
      }
    }
  }

  /** 校验 run 归属（run → task → session 逐级收敛到 tenant/user）：非本租户本人一律 404，不泄露存在性。 */
  async assertRunOwned(runId: string, tenantId: string, userId: string): Promise<void> {
    const run = await this.prisma.run.findFirst({
      where: { id: runId, task: { session: { tenantId, userId } } },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('run_not_found');
  }

  /** 取消路径的归属查询：同时带回 taskId/status/取消请求，避免二次查询。 */
  async findOwnedRun(
    runId: string,
    tenantId: string,
    userId: string,
  ): Promise<{ id: string; taskId: string; status: string; cancelRequestedAt: Date | null }> {
    const run = await this.prisma.run.findFirst({
      where: { id: runId, task: { session: { tenantId, userId } } },
      select: { id: true, taskId: true, status: true, cancelRequestedAt: true },
    });
    if (!run) throw new NotFoundException('run_not_found');
    return {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      cancelRequestedAt: run.cancelRequestedAt ?? null,
    };
  }

  /**
   * 取消仍在排队的运行：run 与 task 必须一起落到 canceled。
   * run 与 task 分属两行，只改其一会让前端/后台看到「run 已取消、task 仍在排队」的撕裂状态，
   * 因此用同一事务条件更新：run 未抢到（已开始执行或并发取消）返回 false，由调用方回查 DB；
   * task 条件更新失败属于数据不一致，抛错回滚整笔事务；DB 故障也原样上抛，
   * 让 POST /cancel 返回 5xx 供客户端重试，而不是把基础设施故障谎报成「取消未发生」。
   */
  async markCanceled(runId: string, taskId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const endedAt = new Date();
      const run = await tx.run.updateMany({
        where: { id: runId, status: 'queued' },
        data: { status: 'canceled', endedAt },
      });
      if (run.count === 0) return false;
      const task = await tx.task.updateMany({
        where: { id: taskId, status: 'queued' },
        data: { status: 'canceled', endedAt },
      });
      if (task.count === 0) throw new Error('task_not_queued');
      return true;
    });
  }

  /**
   * 请求取消执行中的运行，竞态下 0 行不报错。
   * 同时接受 queued 与 running：执行器可能已经取走作业但还没写入 running，
   * 排队取消路径会落到这里；只匹配 running 会静默丢弃这次取消。
   */
  async markCancelRequested(runId: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { cancelRequestedAt: new Date() },
    });
  }

  /**
   * 为失败/取消的任务创建一次重试：复用 Task.input 里固化的快照，只新增 Run 行。
   * 必须在同一事务内完成「重置任务 + 建 run」，否则中途失败会留下 attempts 已加、
   * 却没有可执行 run 的悬空任务。
   */
  async createRetryRun(
    taskId: string,
    traceId: string | null,
  ): Promise<{ runId: string; taskId: string; sessionId: string; attempt: number }> {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: { id: true, attempts: true, status: true, input: true, sessionId: true },
      });
      // 快照缺失说明入队不完整或数据被清理，重试没有可执行的输入，必须拒绝。
      if (!task || task.input == null) throw new ConflictException('task_snapshot_missing');
      if (task.status !== 'failed' && task.status !== 'canceled') {
        throw new ConflictException('task_not_retryable');
      }

      // 在自增前先固定新 attempt 的值：updateMany 之后行对象可能已被改写，
      // 依赖自增后的内存值会让实现细节（ORM 返回的是快照还是引用）影响结果。
      const attempt = task.attempts + 1;

      // 用 attempts 做 CAS 而不是无条件 update：用户双击或并发请求会同时读到同一个
      // attempts，只有先写入者能把 attempts 推进到下一值；后到者 0 行即输掉竞态，
      // 从而保证「一次重试只建一个 run」。状态条件同时兜住并发收尾导致的非失败态。
      const reset = await tx.task.updateMany({
        where: {
          id: taskId,
          attempts: task.attempts,
          status: { in: ['failed', 'canceled'] },
        },
        data: {
          attempts: { increment: 1 },
          status: 'queued',
          lastError: null,
          startedAt: null,
          endedAt: null,
        },
      });
      if (reset.count !== 1) throw new ConflictException('task_busy');

      const run = await tx.run.create({
        // startedAt 留给执行器在真正开始时写入，重试入队阶段仍视为未开始。
        data: { taskId, attempt, status: 'queued', traceId },
      });
      return { runId: run.id, taskId, sessionId: task.sessionId, attempt };
    });
  }

  /**
   * 回收已失联的运行：只有抢到 run 的 running→failed 条件更新才算真正收尾。
   * 若 run 恰好已正常结束，条件更新 0 行，绝不能再去改 task，否则会把刚写好的
   * done/canceled 覆盖成 failed。task 未同步为 running 属于历史数据不一致，
   * 这里只跳过而不抛错，日志由调用方负责。
   */
  async failStaleRun(runId: string, taskId: string, lastError: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const endedAt = new Date();
      const run = await tx.run.updateMany({
        where: { id: runId, status: 'running' },
        data: { status: 'failed', endedAt },
      });
      if (run.count === 0) return false;
      await tx.task.updateMany({
        where: { id: taskId, status: 'running' },
        data: { status: 'failed', lastError, endedAt },
      });
      return true;
    });
  }

  /**
   * 重试入队失败后的回滚：只回收仍是 queued 的运行。
   * queue.submit 可能已经写入 Redis、只是响应丢失后报错，此时 worker 仍会执行并正常收尾；
   * 无条件覆盖会把 done/canceled 改写成 failed，并让客户端误以为可以再次重试。
   */
  async failQueuedAttempt(runId: string, taskId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.run.updateMany({
        where: { id: runId, status: 'queued' },
        data: { status: 'failed', endedAt: new Date() },
      });
      if (run.count === 0) return false;
      await tx.task.updateMany({
        where: { id: taskId, status: 'queued' },
        data: { status: 'failed', lastError: 'enqueue_failed' },
      });
      return true;
    });
  }

  /**
   * 列出可能失联的运行，供启动/周期恢复扫描。
   * 只取 startedAt 非空且早于阈值的行：startedAt 为空表示作业从未被取走，
   * 不属于 worker 失联，本方法不负责这类排队侧滞留。
   */
  async listStaleRunningRuns(
    before: Date,
    limit = 100,
  ): Promise<{ id: string; taskId: string; sessionId: string; startedAt: Date }[]> {
    const rows = await this.prisma.run.findMany({
      where: { status: 'running', startedAt: { not: null, lt: before } },
      orderBy: { startedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        taskId: true,
        startedAt: true,
        task: { select: { sessionId: true } },
      },
    });
    // 查询条件已排除 null，这里断言以保持返回类型精确。
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      sessionId: r.task.sessionId,
      startedAt: r.startedAt!,
    }));
  }

  /** 列出取消请求已过期仍未生效的运行：控制消息可能发布在订阅建立之前，需要重发。 */
  async listStaleCancelRequests(before: Date, limit = 100): Promise<{ id: string }[]> {
    return this.prisma.run.findMany({
      where: { status: 'running', cancelRequestedAt: { not: null, lt: before } },
      orderBy: { cancelRequestedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  }
}
