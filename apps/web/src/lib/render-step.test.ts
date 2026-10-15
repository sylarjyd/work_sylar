import { describe, it, expect } from 'vitest';
import { renderStep } from './render-step';
import type { AgentEvent } from '@ai-office/shared';

const ev = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
  runId: 'r',
  seq: 0,
  type,
  payload,
  ts: 0,
});

describe('renderStep', () => {
  it('think 展示文本', () => {
    expect(renderStep(ev('think', { text: '思考中' }))).toBe('思考：思考中');
  });
  it('tool_call 展示工具名与参数', () => {
    expect(renderStep(ev('tool_call', { tool: 'web.search', args: { query: 'x' } }))).toContain(
      'web.search',
    );
  });
  it('tool_result 成功/失败文案不同', () => {
    expect(renderStep(ev('tool_result', { tool: 'web.search', ok: true }))).toContain('成功');
    expect(renderStep(ev('tool_result', { tool: 'web.search', ok: false }))).toContain('失败');
  });
});
