import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { isLoopback } from '../kb/loopback';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** /metrics 与 /health/ready：仅回环或携带正确内部 token。 */
export function observabilityAllowed(req: FastifyRequest): boolean {
  if (isLoopback(req.ip)) return true;
  const token = process.env.INTERNAL_TOKEN;
  const got = req.headers['x-internal-token'];
  return !!token && typeof got === 'string' && safeEqual(got, token);
}
