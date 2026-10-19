import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { AgentEvent, ChatMessage } from '@ai-office/shared';

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

    const prior = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    const task = await this.prisma.task.create({
      data: { sessionId, goal, status: 'running' },
    });
    const run = await this.prisma.run.create({
      data: { id: runId, taskId: task.id, status: 'running' },
    });
    await this.prisma.message.create({
      data: { sessionId, role: 'user', content: goal, seq: prior.length },
    });

    const messages: ChatMessage[] = [
      ...prior.map((m) => ({ role: m.role as ChatMessage['role'], content: m.content })),
      { role: 'user', content: goal },
    ];
    return { taskId: task.id, runId: run.id, tenantId, userId, messages };
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
      const count = await this.prisma.message.count({ where: { sessionId } });
      await this.prisma.message.create({
        data: { sessionId, role: 'assistant', content: assistantText, seq: count },
      });
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
