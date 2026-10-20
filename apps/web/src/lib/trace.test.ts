import { describe, expect, it } from 'vitest';
import { newRequestId, newTraceparent } from './trace';

describe('trace headers', () => {
  it('生成合法且非零的 W3C traceparent', () => {
    const value = newTraceparent();
    expect(value).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [, traceId, spanId] = value.split('-');
    expect(traceId).not.toMatch(/^0+$/);
    expect(spanId).not.toMatch(/^0+$/);
    expect(newTraceparent()).not.toBe(value);
  });

  it('请求 ID 满足 BFF 的 [A-Za-z0-9-]{1,64} 约束', () => {
    expect(newRequestId()).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });
});
