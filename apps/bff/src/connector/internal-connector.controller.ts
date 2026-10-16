import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ConnectorService, type EnabledConnector } from './connector.service';
import { isLoopback } from '../kb/loopback';

/**
 * 内部端点：供 runtime 拉取启用连接器（含解密 env）。
 * 与 M4a 一致，fail-closed：配了 INTERNAL_TOKEN 用共享密钥；未配则仅放行回环来源。
 */
@Controller('internal/connectors')
export class InternalConnectorController {
  constructor(private readonly connectors: ConnectorService) {}

  @Get()
  async list(
    @Req() req: FastifyRequest,
    @Query('tenantId') tenantId: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const token = process.env.INTERNAL_TOKEN;
    if (token) {
      if (req.headers['x-internal-token'] !== token) {
        reply.status(401).send({ error: 'unauthorized' });
        return;
      }
    } else if (!isLoopback(req.ip)) {
      reply.status(403).send({ error: 'forbidden' });
      return;
    }
    if (!tenantId) {
      reply.status(400).send({ error: 'missing_tenant' });
      return;
    }
    const list: EnabledConnector[] = await this.connectors.listEnabled(tenantId);
    reply.status(200).send(list);
  }
}
