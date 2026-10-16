import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@ai-office/shared';
import { currentConfirmCard } from './pending-confirm';

const ev = (type: AgentEvent['type'], payload: Record<string, unknown> = {}): AgentEvent => ({
  runId: 'r',
  seq: 0,
  type,
  payload,
  ts: 0,
});

describe('currentConfirmCard', () => {
  it('无 confirm_request 时返回 null', () => {
    expect(currentConfirmCard([ev('think'), ev('tool_call')])).toBeNull();
  });

  it('confirm_request 后尚无 tool_result → 返回卡片', () => {
    const card = currentConfirmCard([
      ev('tool_call', { tool: 'code.exec' }),
      ev('confirm_request', { confirmId: 'c1', tool: 'code.exec', args: { code: '1+1' } }),
    ]);
    expect(card).toEqual({ confirmId: 'c1', tool: 'code.exec', args: { code: '1+1' } });
  });

  it('confirm_request 收到 tool_result 后 → 返回 null', () => {
    expect(
      currentConfirmCard([
        ev('confirm_request', { confirmId: 'c1', tool: 'code.exec', args: {} }),
        ev('tool_result', { tool: 'code.exec', ok: true, approved: true }),
      ]),
    ).toBeNull();
  });

  it('串联多次确认时返回最后一个未决', () => {
    const card = currentConfirmCard([
      ev('confirm_request', { confirmId: 'c1', tool: 'code.exec', args: {} }),
      ev('tool_result', { tool: 'code.exec', ok: false, denied: true }),
      ev('confirm_request', { confirmId: 'c2', tool: 'code.exec', args: { code: '2' } }),
    ]);
    expect(card?.confirmId).toBe('c2');
  });
});
