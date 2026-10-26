import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
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
import { RunsService } from './runs.service';
import { RunRelayService } from '../queue/run-relay.service';
import { RUN_CONTROL_BUS } from '../queue/queue.tokens';
import type { RunControlBus } from '../queue/run-control-bus';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';

/**
 * 解析重连游标：只接受可选负号的十进制整数且 >= -1。
 *
 * 注意空串与空白必须拒绝——`Number('') === 0` 会被误当成「从 seq 0 之后回放」，
 * 从而漏掉第一条步骤；任何非法值都回退为 -1（从头回放）。
 */
function parseCursor(raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) return -1;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) && seq >= -1 ? seq : -1;
}

@Controller('api/runs')
@UseGuards(JwtGuard)
export class RunsController {
  constructor(
    private readonly tasks: TasksService,
    private readonly runs: RunsService,
    private readonly relay: RunRelayService,
    @Inject(RUN_CONTROL_BUS) private readonly control: RunControlBus,
  ) {}

  /**
   * 断线可重连的事件流：先回放 afterSeq 之后的落库步骤，再转发实时事件。
   * 游标优先取 Last-Event-ID（EventSource 重连时由浏览器自动携带且最新），
   * 首连没有该 header 时退回 query 的 afterSeq。
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
    // Last-Event-ID 是 EventSource 重连时刷新的游标，必须优先于 URL 里可能过期的 query。
    // 非法 header 直接回退 -1，不能悄悄改用 query，否则会重放用户已看过的步骤尾部。
    const afterSeq = parseCursor(lastEventId ?? afterSeqQuery);
    await this.relay.attach(runId, reply, { afterSeq });
  }

  /**
   * 取消运行：排队中的直接撤销，执行中的走控制消息。
   * 归属校验在 RunsService 内先于任何副作用完成；非本人 run 统一 404，不泄露存在性。
   */
  @Post(':id/cancel')
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id') runId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      reply.status(200).send(await this.runs.cancel(runId, user.tenantId, user.sub));
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: 'run_not_found' });
        return;
      }
      throw err;
    }
  }

  /**
   * 确认决策必须抵达持有 runtime 事件流的那个进程：runtime 的待确认 promise 在它自己的
   * ConfirmBroker 里，而任意 BFF 实例都可能收到本请求。因此这里只把决策发到控制总线，
   * 由订阅该 run 的执行器转发给 runtime；直连 runtime 在多实例/队列模式下会打到错误进程，
   * 决策静默丢失直到确认超时。发布失败必须上抛（500），不能假装已送达。
   */
  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: JwtPayload,
    @Param('id') runId: string,
    @Body() body: ConfirmDecision,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // 先 trim 再校验：客户端粘来的空白会变成一个永远匹配不到的决策，只能等 runtime 超时。
    const rawConfirmId = body?.confirmId;
    const confirmId = typeof rawConfirmId === 'string' ? rawConfirmId.trim() : '';
    const approved = body?.approved;
    if (confirmId === '' || typeof approved !== 'boolean') {
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

    await this.control.publish(runId, { type: 'confirm', confirmId, approved });
    reply.status(200).send({ ok: true });
  }
}
