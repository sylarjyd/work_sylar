import type { AgentEvent } from '@ai-office/shared';

export interface ConfirmCard {
  confirmId: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 从事件流里找出**尚未收到 tool_result** 的确认请求。
 * 工具调用在单个 run 内串行，故 `confirm_request` 之后紧邻的下一个 `tool_result`
 * 必是它的决策结果——据此判定“是否仍在等待确认”，无需在 tool_result 里另带 confirmId。
 */
export function currentConfirmCard(events: AgentEvent[]): ConfirmCard | null {
  let card: ConfirmCard | null = null;
  for (const ev of events) {
    if (ev.type === 'confirm_request') {
      card = {
        confirmId: String(ev.payload.confirmId ?? ''),
        tool: String(ev.payload.tool ?? ''),
        args: (ev.payload.args as Record<string, unknown> | undefined) ?? {},
      };
    } else if (ev.type === 'tool_result') {
      card = null;
    }
  }
  return card;
}
