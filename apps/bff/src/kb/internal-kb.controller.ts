import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { KbSearchHit } from '@ai-office/shared';
import { KbService } from './kb.service';

interface SearchBody {
  vector?: number[];
  topK?: number;
  tenantId?: string;
  userId?: string;
}

/** 内部检索端点：供 runtime 调用（不是浏览器）。用共享密钥 INTERNAL_TOKEN 校验，空则不校验（仅限本地）。 */
@Controller('internal/kb')
export class InternalKbController {
  constructor(private readonly kb: KbService) {}

  @Post('search')
  async search(
    @Req() req: FastifyRequest,
    @Body() body: SearchBody,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const token = process.env.INTERNAL_TOKEN;
    if (token && req.headers['x-internal-token'] !== token) {
      reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const { vector, topK, tenantId, userId } = body ?? {};
    if (!Array.isArray(vector) || !tenantId || !userId) {
      reply.status(400).send({ error: 'invalid_params' });
      return;
    }
    const hits: KbSearchHit[] = await this.kb.search(
      tenantId,
      userId,
      vector,
      clampTopK(topK),
    );
    reply.status(200).send(hits);
  }
}

function clampTopK(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(1, Math.trunc(n)));
}
