import type { AgentEvent } from '@ai-office/shared';

/** 把一条 AgentEvent 渲染成人类可读文本（M1 的展示规则，集中一处便于测试）。 */
export function renderStep(ev: AgentEvent): string {
  switch (ev.type) {
    case 'think':
      return `思考：${String(ev.payload.text ?? '')}`;
    case 'tool_call':
      return `调用工具 ${String(ev.payload.tool)}（${JSON.stringify(ev.payload.args ?? {})}）`;
    case 'tool_result':
      return `工具 ${String(ev.payload.tool)} ${ev.payload.ok ? '成功' : '失败'}`;
    case 'artifact':
      return `产出：${JSON.stringify(ev.payload)}`;
  }
}
