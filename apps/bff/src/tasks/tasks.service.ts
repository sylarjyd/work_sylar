import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { AgentEvent, ChatMessage } from '@ai-office/shared';

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

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** 只为归属校验：让控制器能在计费预占之前先做 404 判断。 */
  async assertOwned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);
  }

  /** 建 task/run、落用户消息，并回传喂给模型的完整历史。runId 由控制器预生成（计费预占键）。 */
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
    runId: string,
  ): Promise<{ taskId: string; runId: string; tenantId: string; userId: string; messages: ChatMessage[] }> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);

    // 并发请求会同时读到相同的 max(seq)，进而撞 (sessionId, seq) 唯一键。
    // 整段放进同一事务：重试时前一次的 task/run 已回滚，不会留下孤儿。
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const prior = await tx.message.findMany({
            where: { sessionId },
            orderBy: { seq: 'asc' },
            select: { role: true, content: true, seq: true },
          });
          const task = await tx.task.create({
            data: { sessionId, goal, status: 'running' },
          });
          const run = await tx.run.create({
            data: { id: runId, taskId: task.id, status: 'running' },
          });
          // 用当前最大 seq + 1 而不是长度：历史消息删除后 seq 会有空洞。
          const nextSeq = prior.length > 0 ? prior[prior.length - 1].seq + 1 : 0;
          await tx.message.create({
            data: { sessionId, role: 'user', content: goal, seq: nextSeq },
          });

          const messages: ChatMessage[] = [
            ...prior.map((m) => ({ role: m.role as ChatMessage['role'], content: m.content })),
            { role: 'user', content: goal },
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
