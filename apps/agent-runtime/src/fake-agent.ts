import type { AgentEvent, StepType } from '@ai-office/shared';

interface ScriptedStep {
  type: StepType;
  payload: Record<string, unknown>;
}

function buildScript(goal: string): ScriptedStep[] {
  return [
    { type: 'think', payload: { text: `规划：${goal}` } },
    { type: 'tool_call', payload: { tool: 'web.search', args: { q: goal } } },
    { type: 'tool_result', payload: { tool: 'web.search', ok: true } },
    { type: 'artifact', payload: { kind: 'pptx', name: `${goal}.pptx` } },
  ];
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 模拟 Agent Loop：按脚本逐步吐事件，每步之间有小延迟以模拟真实耗时。
 * M1 起将被真正的（模型驱动）循环替换。
 */
export async function* runFakeAgent(
  goal: string,
  runId: string,
): AsyncGenerator<AgentEvent> {
  const script = buildScript(goal);
  for (let seq = 0; seq < script.length; seq++) {
    const step = script[seq];
    await delay(50);
    yield { runId, seq, type: step.type, payload: step.payload, ts: Date.now() };
  }
}
