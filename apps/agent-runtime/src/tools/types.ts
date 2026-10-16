import type { ToolPermission } from '@ai-office/shared';

/** 单次运行的上下文：工具拼存储 Key 等运行态信息从 here 取，避免工具集在启动期固化单次运行数据。 */
export interface RunContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON-Schema：直接喂给模型做 function-calling。 */
  parameters: Record<string, unknown>;
  /** 权限等级：safe 直接执行；confirm 需用户确认；blocked 一律拒绝。**必填**，杜绝漏标即静默放行。 */
  permission: ToolPermission;
  execute(args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}
