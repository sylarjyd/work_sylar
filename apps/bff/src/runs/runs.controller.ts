import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ConfirmDecision } from '@ai-office/shared';
import { TasksService } from '../tasks/tasks.service';
import { RunRelayService } from '../queue/run-relay.service';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

@Controller('api/runs')
@UseGuards(JwtGuard)
export class RunsController {
  constructor(
    private readonly tasks: TasksService,
    private readonly relay: RunRelayService,
  ) {}

  /**
   * 断线可重连的事件流：先回放 afterSeq 之后的落库步骤，再转发实时事件。
   * 游标优先取 query（浏览器 EventSource 重连会自动带 Last-Event-ID，但首连需显式指定）。
   */
  @Get(':id/stream')
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('id') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('afterSeq') afterSeqQuery: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      await this.tasks.assertRunOwned(runId, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'run_not_found' });
        return;
      }
      throw err;
    }
    // query 优先；非法游标回退为从头回放，不能把 NaN/负数当作合法 seq。
    const raw = afterSeqQuery ?? lastEventId;
    const parsed = raw === undefined ? -1 : Number(raw);
    const afterSeq = Number.isInteger(parsed) && parsed >= -1 ? parsed : -1;
    await this.relay.attach(runId, reply, { afterSeq });
  }

  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: JwtPayload,
    @Param('id') runId: string,
    @Body() body: ConfirmDecision,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const confirmId = body?.confirmId;
    const approved = body?.approved;
    if (typeof confirmId !== 'string' || confirmId === '' || typeof approved !== 'boolean') {
      reply.status(400).send({ error: 'invalid_decision' });
      return;
    }

    // 归属校验：非本人 run 回 404（不泄露存在性）。仅把「不存在」归为 404，
    // 其余（如 DB 连接故障）原样抛出走 500，避免把基础设施异常伪装成 run_not_found。
    try {
      await this.tasks.assertRunOwned(runId, user.tenantId, user.sub);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'run_not_found' });
        return;
      }
      throw err;
    }

    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
    let upstream: Response;
    try {
      upstream = await fetch(`${runtimeUrl}/runs/${encodeURIComponent(runId)}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(runtimeToken ? { 'x-agent-runtime-token': runtimeToken } : {}),
        },
        body: JSON.stringify({ confirmId, approved }),
      });
    } catch {
      reply.status(502).send({ error: 'upstream_unreachable' });
      return;
    }

    if (!upstream.ok) {
      // 上游非 2xx：原样透传状态码与响应体。
      const text = await upstream.text();
      reply
        .status(upstream.status)
        .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
        .send(text || JSON.stringify({ error: 'upstream_error' }));
      return;
    }
    reply
      .status(200)
      .header('content-type', 'application/json')
      .send(await upstream.text());
  }
}
