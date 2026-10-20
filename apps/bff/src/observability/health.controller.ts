import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HealthService } from './health.service';
import { observabilityAllowed } from './observability-access';

@Controller('api/health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  live(): { status: 'ok'; version: string } {
    return { status: 'ok', version: process.env.APP_VERSION ?? '0.0.0' };
  }

  @Get('ready')
  async ready(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!observabilityAllowed(req)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const result = await this.health.ready();
    reply.code(result.status === 'ready' ? 200 : 503).send(result);
  }
}
