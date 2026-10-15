import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createSseParser, type AgentEvent } from '@ai-office/shared';
import type { CreateTaskRequest } from '@ai-office/shared';
import { TasksService } from './tasks.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { writeHead } from '../stream/sse-proxy';

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post(':id/tasks')
  async run(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: CreateTaskRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const goal = body?.goal ?? '';

    // 先做归属校验与建 task/run（可能抛 NotFoundException）。
    // 必须早于 hijack：一旦 hijack，Nest 的异常过滤器无法再写响应，请求会挂起。
    const { taskId, runId, messages } = await this.tasks.prepare(
      sessionId,
      user.tenantId,
      user.sub,
      goal,
    );

    // 接管回复：本方法直接写 reply.raw，必须 hijack，否则 Nest/Fastify 会再自动发一次响应。
    reply.hijack();

    let upstream: Response;
    try {
      upstream = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, sessionId, goal, messages }),
      });
    } catch {
      // 传输层失败：上游不可达，回 502 而不是未捕获的 500。
      await this.tasks.finish(runId, taskId, 'failed', '', sessionId);
      writeHead(reply, 502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
      return;
    }

    if (!upstream.ok || !upstream.body) {
      // 上游非 2xx：原样转发真实状态码与响应体，不伪装成 200 text/event-stream。
      await this.tasks.finish(runId, taskId, 'failed', '', sessionId);
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      writeHead(reply, upstream.status, { 'content-type': contentType });
      reply.raw.end(await upstream.text());
      return;
    }

    writeHead(reply, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const parse = createSseParser();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const thinkTexts: string[] = [];
    let status: 'done' | 'failed' = 'done';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        reply.raw.write(chunk);
        for (const m of parse(chunk)) {
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            if (ev.type === 'think') thinkTexts.push(String(ev.payload.text ?? ''));
            await this.tasks.recordStep(runId, ev);
          } else if (m.event === 'error') {
            status = 'failed';
          }
        }
      }
    } finally {
      await this.tasks.finish(runId, taskId, status, thinkTexts.join('\n'), sessionId);
      reply.raw.end();
    }
  }
}
