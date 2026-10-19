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
    const out = renderStep(ev('tool_call', { tool: 'web.search', args: { query: 'x' } }));
    expect(out).toContain('web.search');
    expect(out).toContain('"query"');
    expect(out).toContain('"x"');
  });
  it('tool_result 成功/失败文案不同', () => {
    expect(renderStep(ev('tool_result', { tool: 'web.search', ok: true }))).toContain('成功');
    expect(renderStep(ev('tool_result', { tool: 'web.search', ok: false }))).toContain('失败');
  });
  it('artifact 展示产出文件名与类型', () => {
    const out = renderStep(ev('artifact', { kind: 'pptx', filename: '报告.pptx' }));
    expect(out).toContain('报告.pptx');
    expect(out).toContain('pptx');
    expect(out).toContain('产出文档');
    expect(out).not.toContain('{');
  });
  it('confirm_request 返回空串（卡片由工作台渲染）', () => {
    expect(renderStep(ev('confirm_request', { confirmId: 'c1', tool: 'code.exec', args: {} }))).toBe('');
  });

  it('kb.retrieve 命中时渲染来源列表（文件名#seq + score）', () => {
    const out = renderStep(
      ev('tool_result', {
        tool: 'kb.retrieve',
        ok: true,
        display: { sources: [{ docName: '报告.docx', seq: 3, score: 0.82, snippet: '片段' }] },
      }),
    );
    expect(out).toContain('报告.docx#3');
    expect(out).toContain('0.82');
    expect(out).toContain('来源');
  });

  it('kb.retrieve 来源 score 非数字时不抛错且仍展示文档引用', () => {
    let out = '';
    expect(() => {
      out = renderStep(
        ev('tool_result', {
          tool: 'kb.retrieve',
          ok: true,
          display: { sources: [{ docName: 'a.txt', seq: 1, score: 'oops' }] },
        }),
      );
    }).not.toThrow();
    expect(out).toContain('a.txt#1');
  });

  it('kb.retrieve 无命中时提示无匹配', () => {
    const out = renderStep(ev('tool_result', { tool: 'kb.retrieve', ok: true, display: { sources: [] } }));
    expect(out).toContain('无匹配');
  });

  it('kb.retrieve 检索不可达时提示失败', () => {
    const out = renderStep(ev('tool_result', { tool: 'kb.retrieve', ok: false, display: { sources: [] } }));
    expect(out).toContain('失败');
  });

  it('notice 渲染为提示文本', () => {
    expect(
      renderStep({
        runId: 'r1',
        seq: 1,
        type: 'notice',
        payload: { code: 'budget_exceeded', message: '预算已用完' },
        ts: 0,
      }),
    ).toBe('提示：预算已用完');
  });
});
