import { Injectable } from '@nestjs/common';
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

  /** 建 task/run、落用户消息，并回传喂给模型的完整历史。 */
  async prepare(
    sessionId: string,
    tenantId: string,
    userId: string,
    goal: string,
  ): Promise<{ taskId: string; runId: string; tenantId: string; messages: ChatMessage[] }> {
    await this.sessions.assertOwned(sessionId, tenantId, userId);

    const prior = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    const task = await this.prisma.task.create({
      data: { sessionId, goal, status: 'running' },
    });
    const run = await this.prisma.run.create({
      data: { taskId: task.id, status: 'running' },
    });
    await this.prisma.message.create({
      data: { sessionId, role: 'user', content: goal, seq: prior.length },
    });

    const messages: ChatMessage[] = [
      ...prior.map((m) => ({ role: m.role as ChatMessage['role'], content: m.content })),
      { role: 'user', content: goal },
    ];
    return { taskId: task.id, runId: run.id, tenantId, messages };
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
}
