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
    case 'artifact': {
      const kind = String(ev.payload.kind ?? '');
      const filename = String(ev.payload.filename ?? '');
      return `产出文档 ${filename}（${kind}）`;
    }
    case 'confirm_request':
      // 卡片由工作台单独渲染；文本渲染器保持纯文本职责，返回空串。
      return '';
    default:
      // 前向兼容：StepType 未来新增类型时，未知事件渲染为空串而非 undefined。
      return '';
  }
}
