import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

/**
 * hijack 之后 Fastify 不再参与发送，中间件写进 reply 的响应头（CORS 等）也不会
 * 自动落到 socket 上。这里把已累积的回复头取出、与本次响应的头合并后显式写入。
 */
export function writeHead(
  reply: FastifyReply,
  status: number,
  headers: OutgoingHttpHeaders,
): void {
  const accumulated: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) accumulated[key] = value;
  }
  reply.raw.writeHead(status, { ...accumulated, ...headers });
}
