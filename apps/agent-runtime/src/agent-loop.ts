import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ConversationDelta,
  RunBilling,
  RunCheckpointEvent,
  RunRequest,
  UsageEvent,
} from '@ai-office/shared';
import { endSpan, startSpan } from '@ai-office/telemetry';
import type { ModelGateway, ModelMessage } from './model/types';
import { prepareAttachmentMessages, requiredModalitiesOf } from './model/attachments';
import type { ConfirmGate } from './confirm/broker';
import type { RunContext, Tool } from './tools/types';
import { scaledValue, toUsageEvent } from './billing';

export interface ToolObservation {
  tool: string;
  status: 'ok' | 'error' | 'denied' | 'blocked';
  durationMs: number;
  /** 仅 code.exec 且子进程因超时被杀时置 true。 */
  codeExecTimeout: boolean;
}

export interface RunDeps {
  gateway: ModelGateway;
  tools: Tool[];
  maxRounds?: number;
  onUsage?: (usage: UsageEvent) => void;
  /** 工具埋点；实现方不应抛错。 */
  onToolCall?: (obs: ToolObservation) => void;
  /** 确认闸门：confirm 级工具执行前挂起等待用户决策；未注入时按拒绝处理（fail-safe）。 */
  confirm?: ConfirmGate;
  /** 确认等待上限（毫秒）。 */
  confirmTimeoutMs?: number;
  /** 本次运行的代码执行上限（毫秒），经 RunContext 传给 code.exec。 */
  codeExecTimeoutMs?: number;
  /** 预占额度、允许模型与价格；缺省时不限预算。 */
  billing?: RunBilling;
  /**
   * 取消信号：客户端断开或 BFF 取消时置位。
   * 网关接口不接收 signal（无法中断在途模型调用），因此在轮次边界与每次工具执行前刹车。
   */
  signal?: AbortSignal;
  /**
   * 每完成一个工具轮回调一次 checkpoint（对话增量 + 下一未用 seq + 累计用量）。
   * 队列模式下 worker 崩溃/重启时，BFF 用它持久化断点，续跑无需重跑已完成的轮次。
   */
  onCheckpoint?: (cp: RunCheckpointEvent) => void;
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
  // 附件在调用模型前统一转换：文本抽正文、媒体转 content parts。
  // 转换在生成器内完成，解析失败会沿 run 的错误通道上报，而不是静默丢掉用户内容。
  const prepared = await prepareAttachmentMessages(req.messages);
  // 自定义助手的系统提示词作为首条消息注入；历史消息只落 user/assistant，不会重复。
  const systemPrompt = req.systemPrompt?.trim();
  const resume = req.resume;
  const messages: ModelMessage[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...prepared,
    // 续跑增量由 BFF 从 checkpoint 重建：assistant 带 toolCalls、tool 带 toolCallId，
    // 与首跑时的历史同构，真实 provider 才不会把续跑当成残缺上下文拒掉。
    ...((resume?.deltas ?? []) as unknown as ModelMessage[]),
  ];
  // 续跑从 checkpoint 的序号与轮次继续，避免重复计入历史步骤与重跑已完成轮次。
  let seq = resume?.seq ?? 0;
  const startRound = resume?.round ?? 0;
  const usageByModel = new Map<string, { input: number; output: number }>(
    (resume?.usage ?? []).map((u) => [u.model, { input: u.input, output: u.output }]),
  );
  // 模态只由本次真实附件决定：续跑增量不含附件，不能据此收窄候选模型。
  const requiredModalities = requiredModalitiesOf(prepared);
  const ctx: RunContext = {
    tenantId: req.tenantId,
    userId: req.userId,
    sessionId: req.sessionId,
    runId: req.runId,
    codeExecTimeoutMs: deps.codeExecTimeoutMs,
    kbIds: req.kbIds,
  };
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
    for (let round = startRound; round < maxRounds; round++) {
      // 本轮新增的对话增量；只在整轮工具执行完毕后随 checkpoint 一起落库，
      // 半轮中断不会留下“有 assistant 无 tool 结果”的残缺历史。
      const roundDeltas: ModelMessage[] = [];
      // 已取消：不再发起新一轮模型调用；已产生的用量仍由 finally 上报。
      if (deps.signal?.aborted) return;
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

      // 用户选中的模型优先；其余候选按运营端排序，供 429/5xx 时自动回退。
      const selected = deps.billing?.selectedModel;
      const allowed = deps.billing?.allowedModels;
      const models = selected
        ? [selected, ...(allowed ?? []).filter((m) => m !== selected)]
        : allowed;
      const resp = await deps.gateway.chat({
        messages,
        tools: schemas,
        models,
        ...(requiredModalities.length > 0 ? { requiredModalities } : {}),
      });
      const prev = usageByModel.get(resp.model) ?? { input: 0, output: 0 };
      usageByModel.set(resp.model, {
        input: prev.input + resp.usage.input,
        output: prev.output + resp.usage.output,
      });

      if (resp.content) {
        yield step('think', { text: resp.content, model: resp.model });
      }
      if (resp.toolCalls.length === 0) {
        // 无工具调用即结束；回填最终 assistant 文本以保持历史完整。
        if (resp.content) messages.push({ role: 'assistant', content: resp.content });
        break;
      }

      // 有工具调用：assistant 回合必须回带 toolCalls、tool 回合回带 toolCallId，
      // 否则真实 provider（DeepSeek/OpenAI 兼容）的多轮 function-calling 会被拒。
      const assistantMsg: ModelMessage = {
        role: 'assistant',
        content: resp.content,
        toolCalls: resp.toolCalls,
      };
      messages.push(assistantMsg);
      roundDeltas.push(assistantMsg);
      for (const call of resp.toolCalls) {
        // 取消可能发生在模型返回之后：不再执行工具，也不产出 tool_call/tool_result。
        if (deps.signal?.aborted) return;
        yield step('tool_call', { tool: call.name, args: call.args });
        const tool = deps.tools.find((t) => t.name === call.name);
        let ok = true;
        let status: ToolObservation['status'] = 'ok';
        let result: unknown;
        const extra: Record<string, unknown> = {};
        const toolStarted = Date.now();
        const toolSpan = startSpan('tool.execute', {
          'gen_ai.tool.name': call.name,
          'run.id': req.runId,
        });
        try {
          if (!tool) throw new Error(`unknown_tool:${call.name}`);
          const permission = effectivePermission(tool.permission, req.permissionMode);
          if (permission === 'blocked') {
            ok = false;
            status = 'blocked';
            extra.blocked = true;
            result = { error: 'blocked' };
          } else if (permission === 'confirm') {
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
              status = 'denied';
              extra.denied = true;
              extra.reason = decision.reason ?? 'user_denied';
              result = { denied: true, reason: extra.reason };
            }
          } else {
            result = await tool.execute(call.args, ctx);
          }
        } catch (err) {
          ok = false;
          status = 'error';
          result = { error: String(err) };
        }
        // 工具返回 {ok:false}（如 MCP 调用失败）即使没有抛错也算失败；
        // 不改 tool_result.ok 的既有语义（它表示“是否抛错/被拒”），只影响埋点。
        if (status === 'ok' && isFailureResult(result)) status = 'error';
        const durationMs = Date.now() - toolStarted;
        endSpan(toolSpan, status === 'ok');
        deps.onToolCall?.({
          tool: call.name,
          status,
          durationMs,
          codeExecTimeout: call.name === 'code.exec' && isTimeoutResult(result),
        });
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
        const toolMsg: ModelMessage = {
          role: 'tool',
          content: (JSON.stringify(result) ?? 'null').slice(0, 4000),
          toolCallId: call.id,
        };
        messages.push(toolMsg);
        roundDeltas.push(toolMsg);
      }

      // 只有完整走完工具轮才落 checkpoint：seq 是下一个未用序号，
      // BFF 可据此截断半轮步骤并只回放已确认的增量。无工具轮会在此前 break，
      // 不会重复发一次没有续跑价值的 checkpoint。
      if (roundDeltas.length > 0) {
        deps.onCheckpoint?.({
          round: round + 1,
          seq,
          deltas: roundDeltas as unknown as ConversationDelta[],
          usage: [...usageByModel].map(([model, u]) => ({ model, ...u })),
        });
      }
    }
  } finally {
    // 模型调用中途抛错/客户端提前断开时，已产生的用量也必须上报，避免漏计。
    if (usageByModel.size > 0) deps.onUsage?.(toUsageEvent(usageByModel));
  }
}

/**
 * 助手权限模式只影响 confirm 级工具：
 * - readonly：需确认的写操作一律拒绝（blocked 的工具始终拒绝）；
 * - auto：需确认的写操作自动放行；
 * safe/blocked 的原有语义不变。
 */
function effectivePermission(
  base: Tool['permission'],
  mode: RunRequest['permissionMode'],
): Tool['permission'] {
  if (base === 'blocked' || !mode || mode === 'standard') return base;
  if (mode === 'readonly') return base === 'confirm' ? 'blocked' : base;
  return base === 'confirm' ? 'safe' : base;
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

function isFailureResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
}

function isTimeoutResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { timeout?: unknown }).timeout === true;
}

/** 工具返回 `{ artifact: ArtifactRef }` 时取出该引用；结构不符则视为无产物。 */
function extractArtifact(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const ref = (result as { artifact?: unknown }).artifact;
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
  return ref as Record<string, unknown>;
}
