import { Controller, Get, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLoopback } from '../kb/loopback';
import { SkillsService } from './skills.service';

/**
 * 内部端点：runtime 在运行中按需读取技能包内文件（模板/脚本/参考资料）。
 * 与其它内部端点一致 fail-closed：配了 INTERNAL_TOKEN 用共享密钥，未配则仅放行回环。
 */
@Controller('internal/skills')
export class InternalSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get(':id/file')
  async file(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Query('tenantId') tenantId: string | undefined,
    @Query('userId') userId: string | undefined,
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
    if (!tenantId || !userId) {
      reply.status(400).send({ error: 'missing_identity' });
      return;
    }
    if (!path) {
      reply.status(400).send({ error: 'missing_path' });
      return;
    }
    try {
      const result = await this.skills.readPackageFile(id, { tenantId, userId }, path);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(result.buffer.length));
      reply.header('x-content-type-options', 'nosniff');
      await reply.send(result.buffer);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: err.message });
        return;
      }
      reply.status(502).send({ error: 'skill_file_unavailable' });
    }
  }
}
