import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BFF_METRICS, type BffMetrics } from './observability.metrics';
import { observabilityAllowed } from './observability-access';

@Controller()
export class MetricsController {
  constructor(@Inject(BFF_METRICS) private readonly metrics: BffMetrics) {}

  @Get('metrics')
  async scrape(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!observabilityAllowed(req)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const body = await this.metrics.registry.metrics();
    reply.header('content-type', this.metrics.registry.contentType).send(body);
  }
}
