import { BadRequestException } from '@nestjs/common';

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

function parseIntParam(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequestException(code);
  return n;
}

/** 统一 offset 分页：page ≥ 1，pageSize 1–100，缺省 20。 */
export function parsePage(page?: unknown, pageSize?: unknown): PageParams {
  const p = parseIntParam(page, 1, 1, 1_000_000, 'invalid_page');
  const s = parseIntParam(pageSize, 20, 1, 100, 'invalid_page_size');
  return { page: p, pageSize: s, skip: (p - 1) * s, take: s };
}

export function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v === '' ? undefined : v;
}

export function optionalDate(raw: unknown, code: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException(code);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(code);
  return d;
}
