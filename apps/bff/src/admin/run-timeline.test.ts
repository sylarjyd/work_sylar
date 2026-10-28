import { describe, expect, it } from 'vitest';
import { buildTimelineNodes, type TimelineRun, type TimelineStep } from './run-timeline';

const run: TimelineRun = {
  id: 'r1',
  status: 'done',
  startedAt: new Date('2026-10-01T00:00:00Z'),
  endedAt: new Date('2026-10-01T00:01:00Z'),
};

function step(
  id: string,
  seq: number,
  type: string,
  payload: unknown,
  second: number,
): TimelineStep {
  return { id, seq, type, payload, ts: new Date(`2026-10-01T00:00:${String(second).padStart(2, '0')}Z`) };
}

const steps: TimelineStep[] = [
  step('s1', 0, 'think', { text: '敏感思考正文' }, 1),
  step('s2', 1, 'tool_call', { tool: 'web.search', input: { q: '敏感入参' } }, 2),
  step('s3', 2, 'confirm_request', { tool: 'web.search' }, 3),
  step('s4', 3, 'tool_result', { tool: 'web.search', ok: true, preview: '敏感结果' }, 4),
  step('s5', 4, 'tool_call', { tool: 'shell.exec', input: '敏感命令' }, 5),
  step('s6', 5, 'tool_result', { tool: 'shell.exec', ok: false, reason: 'user_denied' }, 6),
  step('s7', 6, 'tool_call', { tool: 'http.get' }, 7),
  step('s8', 7, 'tool_result', { tool: 'http.get', ok: false, error: '敏感错误' }, 8),
  step('s9', 8, 'artifact', { kind: 'file', filename: 'report.xlsx', storageKey: 'k', size: 10 }, 9),
  step(
    's10',
    9,
    'chart',
    { kind: 'bar', title: '月度收入', categories: ['一月'], series: [{ name: '收入', data: [1] }] },
    9,
  ),
  step('s11', 10, 'notice', { code: 'budget_exceeded', text: '敏感提示' }, 9),
];

describe('buildTimelineNodes', () => {
  it('按阶段聚合节点并只保留安全标签', () => {
    const { nodes, truncated } = buildTimelineNodes(run, steps);
    expect(nodes.map((n) => n.kind)).toEqual([
      'accepted',
      'think',
      'tool',
      'confirm',
      'tool',
      'tool',
      'artifact',
      'chart',
      'notice',
      'finished',
    ]);
    expect(nodes[0]).toMatchObject({
      label: '已受理',
      status: 'ok',
      startedAt: '2026-10-01T00:00:00.000Z',
      endedAt: '2026-10-01T00:00:01.000Z',
      durationMs: 1000,
    });
    expect(nodes[1]).toMatchObject({ label: '模型思考', durationMs: 1000 });
    expect(nodes[2]).toMatchObject({
      label: 'web.search',
      status: 'ok',
      startedAt: '2026-10-01T00:00:02.000Z',
      endedAt: '2026-10-01T00:00:04.000Z',
      durationMs: 2000,
    });
    expect(nodes[3]).toMatchObject({
      label: '等待确认：web.search',
      status: 'done',
      durationMs: 1000,
    });
    expect(nodes[4]).toMatchObject({ label: 'shell.exec', status: 'denied' });
    expect(nodes[5]).toMatchObject({ label: 'http.get', status: 'failed' });
    expect(nodes[6]).toMatchObject({
      label: 'report.xlsx',
      status: 'ok',
      startedAt: '2026-10-01T00:00:09.000Z',
    });
    // 图表节点只透出标题，不带系列数据。
    expect(nodes[7]).toMatchObject({ kind: 'chart', label: '月度收入', status: 'ok' });
    expect(nodes[8]).toMatchObject({ label: '预算超限', status: 'failed' });
    expect(nodes[9]).toMatchObject({ kind: 'finished', status: 'ok' });
    expect(truncated).toBe(false);

    // 时间线会暴露给管理端与页面，不能带出 prompt/入参/结果正文。
    const dump = JSON.stringify(nodes);
    expect(dump).not.toContain('敏感');
    expect(dump).not.toContain('storageKey');
  });

  it('运行中的未完成工具与结束节点标记 running', () => {
    const running: TimelineRun = { ...run, status: 'running', endedAt: null };
    const pending = [step('t1', 0, 'tool_call', { tool: 'web.search' }, 1)];
    const { nodes } = buildTimelineNodes(running, pending);
    expect(nodes[1]).toMatchObject({ kind: 'tool', status: 'running', endedAt: null });
    expect(nodes[2]).toMatchObject({ kind: 'finished', status: 'running', endedAt: null });
  });

  it('step 被截断时追加省略节点并标记 truncated', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      step(`m${i}`, i, 'think', {}, 1),
    );
    const { nodes, truncated } = buildTimelineNodes(run, many, 700);
    expect(truncated).toBe(true);
    expect(nodes.length).toBeLessThanOrEqual(500);
    expect(nodes[nodes.length - 1].kind).toBe('notice');
    expect(nodes[nodes.length - 1].label).toMatch(/^其余 \d+ 个节点已省略$/);
  });
});
