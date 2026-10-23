import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { KbSearchHit } from '@ai-office/shared';
import { KbService } from './kb.service';
import { isLoopback } from './loopback';

interface SearchBody {
  vector?: number[];
  topK?: number;
  tenantId?: string;
  userId?: string;
  kbIds?: string[];
}

/**
 * 内部检索端点：供 runtime 调用（不是浏览器）。
 * 配了 INTERNAL_TOKEN 用共享密钥校验；未配时失败关闭（fail-closed），仅放行回环来源——
 * bff 绑定 0.0.0.0 且 CORS 开放，若默认放行则本端点会成为跨租户读取的后门。
 */
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
    if (token) {
      if (req.headers['x-internal-token'] !== token) {
        reply.status(401).send({ error: 'unauthorized' });
        return;
      }
    } else if (!isLoopback(req.ip)) {
      reply.status(403).send({ error: 'forbidden' });
      return;
    }
    const { vector, topK, tenantId, userId, kbIds } = body ?? {};
    // 旧版文档级绑定字段：滚动部署期间若 runtime 仍传 docIds，直接拒绝而不是忽略，
    // 否则“空范围=全部知识库”会把检索面放大成本用户全部文档。
    if ((body as { docIds?: unknown } | null)?.docIds !== undefined) {
      reply.status(400).send({ error: 'invalid_params' });
      return;
    }
    if (!isValidVector(vector) || !isNonEmptyString(tenantId) || !isNonEmptyString(userId)) {
      reply.status(400).send({ error: 'invalid_params' });
      return;
    }
    if (kbIds !== undefined && !isValidKbIds(kbIds)) {
      reply.status(400).send({ error: 'invalid_params' });
      return;
    }
    const hits: KbSearchHit[] = await this.kb.search(
      tenantId,
      userId,
      vector,
      clampTopK(topK),
      kbIds,
    );
    reply.status(200).send(hits);
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 向量必须是「非空且全部为有限数字」的数组，否则 pgvector 写入/查询会 500 而非 400。 */
function isValidVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** 知识库范围只接受非空字符串数组；租户/用户过滤仍由 SQL 强制执行，越权 ID 不会泄露数据。 */
function isValidKbIds(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= 100 &&
    v.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
  );
}

function clampTopK(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(1, Math.trunc(n)));
}
