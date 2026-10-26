import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { attachmentKindFor, type AgentEvent } from '@ai-office/shared';
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
   * 建 task/run、落用户消息并绑定附件，回传喂给模型的完整历史（尚未读取附件字节）。
   * runId 由控制器预生成（计费预占键）；附件在事务内原子认领，并发重复发送只会有一次成功。
   */
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
    runId: string,
    traceId?: string | null,
    attachmentIds: string[] = [],
  ): Promise<{
    taskId: string;
    runId: string;
    tenantId: string;
    userId: string;
    messages: PreparedMessage[];
  }> {
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
            data: { sessionId, goal, status: 'running' },
          });
          const run = await tx.run.create({
            // startedAt 已去掉数据库默认值；过渡期显式写入，Task 9 改为 queued 后由执行器写入。
            data: {
              id: runId,
              taskId: task.id,
              status: 'running',
              startedAt: new Date(),
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
          return { taskId: task.id, runId: run.id, tenantId, userId, messages };
        });
      } catch (err) {
        // 非 seq 唯一键冲突（如 runId 主键冲突）重试也不会成功，立即抛出。
        if (!isSeqConflict(err) || attempt >= MAX_SEQ_ATTEMPTS - 1) {
          throw err;
        }
      }
    }
  }

  /** 读取入队时固化的运行快照；缺失说明入队不完整或数据被清理，执行器据此失败收尾。 */
  async loadSnapshot(taskId: string): Promise<RunSnapshot> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || !task.input) throw new NotFoundException('task_snapshot_missing');
    return task.input as unknown as RunSnapshot;
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

  async finish(
    runId: string,
    taskId: string,
    status: 'done' | 'failed',
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
}
