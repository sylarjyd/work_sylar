import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ConnectorDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { ConnectorService, ValidateFailedError, type ConnectorInput, type ConnectorPatch } from './connector.service';

/**
 * 连接器管理：仅管理员可增删改查；所有操作限定在当前租户内。
 * 创建/改运行参数时先经 runtime 试启动校验，失败统一映射为 400。
 */
@Controller('api/connectors')
@UseGuards(JwtGuard, AdminGuard)
export class ConnectorController {
  constructor(private readonly connectors: ConnectorService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<ConnectorDto[]> {
    return this.connectors.list(user.tenantId);
  }

  @Post()
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() body: ConnectorInput,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const dto = await this.connectors.create(body, user.tenantId, user.sub);
      reply.status(201).send(dto);
    } catch (err) {
      sendMapped(err, reply);
    }
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: ConnectorPatch,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      reply.status(200).send(await this.connectors.update(id, user.tenantId, body));
    } catch (err) {
      sendMapped(err, reply, 'connector_not_found');
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      await this.connectors.remove(id, user.tenantId);
      reply.status(204).send();
    } catch (err) {
      sendMapped(err, reply, 'connector_not_found');
    }
  }
}

/** 把 service 抛出的领域异常映射为 HTTP 响应；未识别的一律重抛由 Nest 兜底。 */
function sendMapped(err: unknown, reply: FastifyReply, notFound = 'connector_not_found'): void {
  if (err instanceof ValidateFailedError) {
    // ValidateFailedError.message 已是固定码（Task 5 起不再回传 runtime 原始错误），无需再透传 reason。
    reply.status(400).send({ error: 'validate_failed' });
    return;
  }
  if (err instanceof ConflictException) {
    reply.status(400).send({ error: 'duplicate_name' });
    return;
  }
  if (err instanceof NotFoundException) {
    reply.status(404).send({ error: notFound });
    return;
  }
  throw err;
}
