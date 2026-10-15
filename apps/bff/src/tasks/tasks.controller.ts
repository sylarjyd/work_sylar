import { Body, Controller, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createSseParser, type AgentEvent, type CreateTaskRequest } from '@ai-office/shared';
import { TasksService } from './tasks.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { writeHead } from '../stream/sse-proxy';

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(private readonly tasks: TasksService) {}

  @Post(':id/tasks')
  async run(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: CreateTaskRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
    const goal = body?.goal;

    // 边界校验：goal 必须是非空字符串。此时尚未建 task/run，也尚未 hijack，
    // 交给 Nest/Fastify 正常回 400 即可。
    if (typeof goal !== 'string' || goal.length === 0) {
      reply.status(400).send({ error: 'invalid_goal' });
      return;
    }

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

    // 客户端中断/套接字异常：停止拉流，且 socket error 无监听会崩进程，必须挂空处理器。
    // reader 提前声明：close 一触发就主动 cancel 上游读取。否则若客户端在
    // await reader.read() 期间断开，只能等上游把剩余数据发完才会 cancel，白白占住连接。
    let clientGone = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onClientGone = (): void => {
      clientGone = true;
      reader?.cancel().catch(() => undefined);
    };
    reply.raw.on('error', onClientGone);
    reply.raw.on('close', onClientGone);

    let upstream: Response;
    try {
      upstream = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 配了共享密钥才带；不配时与未开启鉴权的 runtime 保持兼容。
          ...(runtimeToken ? { 'x-agent-runtime-token': runtimeToken } : {}),
        },
        body: JSON.stringify({ runId, sessionId, goal, messages }),
      });
    } catch {
      // 传输层失败：上游不可达，回 502 而不是未捕获的 500。
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
      writeHead(reply, 502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
      return;
    }

    if (!upstream.ok || !upstream.body) {
      // 上游非 2xx：原样转发真实状态码与响应体，不伪装成 200 text/event-stream。
      await this.safeFinish(runId, taskId, 'failed', '', sessionId);
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
    reader = upstream.body.getReader();
    const thinkTexts: string[] = [];
    let status: 'done' | 'failed' = 'done';

    try {
      for (;;) {
        if (clientGone) {
          // 客户端已断开：停止拉流，避免对已销毁的 socket 继续 write。
          await reader.cancel().catch(() => undefined);
          break;
        }
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
    } catch (err) {
      // 读上游 / 解析 / 落库任何一环抛错，都必须把这次 run 记为 failed，
      // 否则会带着默认的 'done' 落库，把失败的运行伪装成成功。
      status = 'failed';
      this.logger.error(`run ${runId} 处理失败，标记为 failed: ${(err as Error).message}`);
    } finally {
      // finish 可能因数据库写入失败而 reject；此时仍必须终止（已 hijack 的）响应，
      // 否则客户端永远等不到流结束。finish 做 best-effort，end 无条件执行。
      await this.safeFinish(runId, taskId, status, thinkTexts.join('\n'), sessionId);
      try {
        reply.raw.end();
      } catch {
        // 客户端已断开时 end() 可能抛错，忽略。
      }
    }
  }

  /** 落库收尾；失败只记日志，绝不向调用方抛出——否则会阻断后续的响应终止。 */
  private async safeFinish(
    runId: string,
    taskId: string,
    status: 'done' | 'failed',
    assistantText: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.tasks.finish(runId, taskId, status, assistantText, sessionId);
    } catch (err) {
      this.logger.error(`run ${runId} finish 落库失败: ${(err as Error).message}`);
    }
  }
}
