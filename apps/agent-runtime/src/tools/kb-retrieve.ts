import type { KbSearchHit } from '@ai-office/shared';
import type { Tool } from './types';
import type { EmbeddingGateway } from '../embedding/types';
import { searchKb, type KbClientConfig } from '../kb/bff-client';

const MAX_SNIPPET = 200;

export interface KbRetrieveConfig {
  baseUrl: string;
  internalToken?: string;
  embed: EmbeddingGateway;
  fetchImpl?: typeof fetch;
}

/** 检索用户知识库并返回带来源引用的切片。safe：只读、无副作用。 */
export function createKbRetrieveTool(cfg: KbRetrieveConfig): Tool {
  const client: KbClientConfig = {
    baseUrl: cfg.baseUrl,
    internalToken: cfg.internalToken,
    fetchImpl: cfg.fetchImpl,
  };
  return {
    name: 'kb.retrieve',
    description:
      '检索用户的知识库，返回与查询最相关的文档切片及来源引用。当用户问题可能涉及已上传的私有文档时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询（自然语言）' },
        topK: { type: 'number', description: '返回条数，1-20，默认 5' },
      },
      required: ['query'],
    },
    permission: 'safe',
    async execute(args, ctx) {
      const query = String(args.query ?? '').trim();
      const topK = clampTopK(args.topK);
      let hits: KbSearchHit[];
      try {
        const [vector] = await cfg.embed.embed([query]);
        if (!vector) throw new Error('empty_embedding');
        hits = await searchKb(client, {
          vector,
          topK,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          // 助手绑定文档时只在该范围内检索；空/缺省表示全部。
          ...(ctx.kbDocIds && ctx.kbDocIds.length > 0 ? { docIds: ctx.kbDocIds } : {}),
        });
        if (!Array.isArray(hits)) throw new Error('invalid_search_response');
      } catch {
        // 检索不可达不中断 agent loop：回结构化失败，模型据此说明。
        return {
          ok: false,
          tool: 'kb.retrieve',
          error: 'kb_search_unreachable',
          text: '知识库暂时不可用',
          display: { sources: [] },
        };
      }
      if (hits.length === 0) {
        return { ok: true, tool: 'kb.retrieve', text: '知识库无匹配内容', display: { sources: [] } };
      }
      return {
        ok: true,
        tool: 'kb.retrieve',
        text: hits.map((h) => `[来源: ${h.docName}#${h.seq}] ${h.text}`).join('\n\n'),
        display: {
          sources: hits.map((h) => ({
            docName: h.docName,
            seq: h.seq,
            score: h.score,
            snippet: h.text.slice(0, MAX_SNIPPET),
          })),
        },
      };
    },
  };
}

/** clamp 到 [1,20]，默认 5；非数字回退默认。 */
function clampTopK(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(1, Math.trunc(n)));
}
