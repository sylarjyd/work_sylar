import { randomUUID } from 'node:crypto';
import type { AgentEvent, RunBilling, RunRequest, UsageEvent } from '@ai-office/shared';
import type { ModelGateway, ModelMessage } from './model/types';
import type { ConfirmGate } from './confirm/broker';
import type { RunContext, Tool } from './tools/types';
import { scaledValue, toUsageEvent } from './billing';

export interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;
  onUsage?: (usage: UsageEvent) => void;
  /** 确认闸门：confirm 级工具执行前挂起等待用户决策；未注入时按拒绝处理（fail-safe）。 */
  confirm?: ConfirmGate;
  /** 确认等待上限（毫秒）。 */
  confirmTimeoutMs?: number;
  /** 预占额度、允许模型与价格；缺省时不限预算。 */
  billing?: RunBilling;
}

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120000;

/**
 * plan → act → observe 循环（上游 §5.1 的 M1 精简实现）。
 * 每次模型返回无 tool_call 即结束；受 maxRounds 上限保护，防失控。
 */
export async function* runAgent(req: RunRequest, deps: RunDeps): AsyncGenerator<AgentEvent> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const schemas = deps.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const messages: ModelMessage[] = [...req.messages];
  const ctx: RunContext = {
    tenantId: req.tenantId,
    userId: req.userId,
    sessionId: req.sessionId,
    runId: req.runId,
  };
  let seq = 0;
  const usageByModel = new Map<string, { input: number; output: number }>();
  const step = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
    runId: req.runId,
    seq: seq++,
    type,
    payload,
    ts: Date.now(),
  });

  // 注：M1 下耗尽 maxRounds 会静默结束（客户端只看到 done），
  // “轮次耗尽”这一信号留待后续里程碑；此处不新增事件、不改变输出契约。
  try {
    for (let round = 0; round < maxRounds; round++) {
      // 预算在发起下一轮之前判断：超限立即刹车，不再浪费一次模型调用。
      // 首轮不做判断——预占额度已保证至少可跑一轮。
      if (round > 0 && deps.billing) {
        const scaled = scaledValue(
          [...usageByModel].map(([model, u]) => ({ model, ...u })),
          deps.billing.prices,
        );
        if (scaled >= deps.billing.maxCredits * 1_000_000) {
          yield step('notice', {
            code: 'budget_exceeded',
            message: '本次运行已达到积分预算上限，已停止',
          });
          break;
        }
      }

      const resp = await deps.gateway.chat({
        messages,
        tools: schemas,
        models: deps.billing?.allowedModels,
      });
      const prev = usageByModel.get(resp.model) ?? { input: 0, output: 0 };
      usageByModel.set(resp.model, {
        input: prev.input + resp.usage.input,
        output: prev.output + resp.usage.output,
      });

      if (resp.content) {
        yield step('think', { text: resp.content });
      }
      if (resp.toolCalls.length === 0) {
        // 无工具调用即结束；回填最终 assistant 文本以保持历史完整。
        if (resp.content) messages.push({ role: 'assistant', content: resp.content });
        break;
      }

      // 有工具调用：assistant 回合必须回带 toolCalls、tool 回合回带 toolCallId，
      // 否则真实 provider（DeepSeek/OpenAI 兼容）的多轮 function-calling 会被拒。
      messages.push({ role: 'assistant', content: resp.content, toolCalls: resp.toolCalls });
      for (const call of resp.toolCalls) {
        yield step('tool_call', { tool: call.name, args: call.args });
        const tool = deps.tools.find((t) => t.name === call.name);
        let ok = true;
        let result: unknown;
        const extra: Record<string, unknown> = {};
        try {
          if (!tool) throw new Error(`unknown_tool:${call.name}`);
          if (tool.permission === 'blocked') {
            ok = false;
            extra.blocked = true;
            result = { error: 'blocked' };
          } else if (tool.permission === 'confirm') {
            const confirmId = randomUUID();
            // 不变式：confirm_request 必须在 await 之前 yield，否则卡片无法下发、BFF 无从落库。
            yield step('confirm_request', { confirmId, tool: call.name, args: call.args });
            const decision = deps.confirm
              ? await deps.confirm.request(
                  req.runId,
                  confirmId,
                  deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
                )
              : { approved: false, reason: 'user_denied' as const };
            if (decision.approved) {
              extra.approved = true;
              result = await tool.execute(call.args, ctx);
            } else {
              ok = false;
              extra.denied = true;
              extra.reason = decision.reason ?? 'user_denied';
              result = { denied: true, reason: extra.reason };
            }
          } else {
            result = await tool.execute(call.args, ctx);
          }
        } catch (err) {
          ok = false;
          result = { error: String(err) };
        }
        yield step('tool_result', {
          tool: call.name,
          ok,
          preview: preview(result),
          ...extra,
          ...displayOf(result),
        });
        // 工具产出物：除 tool_result 外再补一条 artifact step，供 BFF 落库、web 成果区即时渲染。
        const artifact = ok ? extractArtifact(result) : undefined;
        if (artifact) {
          yield step('artifact', artifact);
        }
        // 工具结果回填进对话，供下一轮模型使用（截断防上下文爆炸）。
        messages.push({
          role: 'tool',
          content: (JSON.stringify(result) ?? 'null').slice(0, 4000),
          toolCallId: call.id,
        });
      }
    }
  } finally {
    // 模型调用中途抛错/客户端提前断开时，已产生的用量也必须上报，避免漏计。
    if (usageByModel.size > 0) deps.onUsage?.(toUsageEvent(usageByModel));
  }
}

function preview(value: unknown): unknown {
  const s = JSON.stringify(value) ?? 'null';
  return s.length > 500 ? { truncated: true, text: s.slice(0, 500) } : value;
}

/** 工具结果里的 `display` 字段原样透传（不做 500 字截断），供前端渲染结构化展示（如知识库来源）。 */
function displayOf(result: unknown): { display?: unknown } {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return {};
  const d = (result as { display?: unknown }).display;
  return d === undefined ? {} : { display: d };
}

/** 工具返回 `{ artifact: ArtifactRef }` 时取出该引用；结构不符则视为无产物。 */
function extractArtifact(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const ref = (result as { artifact?: unknown }).artifact;
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
  return ref as Record<string, unknown>;
}
