/**
 * 运行错误码与前端展示文案的唯一来源。
 *
 * T6 约定系统级 error 帧为 `{ message: <中文展示文案>, error: <机器码> }`：
 * message 直接给用户看，机器码只留给日志与客户端分支判断，二者不可互换。
 */
export const RUN_ERROR_MESSAGES = {
  plan_expired: '套餐已过期，请续费后重试',
  insufficient_credits: '积分不足，请充值后重试',
  run_failed: '本次运行失败，请稍后重试',
  attachment_unavailable: '附件读取失败，请重新上传',
  upstream_unreachable: '模型服务不可达，请稍后重试',
  upstream_error: '模型服务返回错误，请稍后重试',
  upstream_empty_body: '模型服务返回空响应，请稍后重试',
} as const;

export type RunErrorCode = keyof typeof RUN_ERROR_MESSAGES;

/**
 * SSE 转发链路自身的系统级错误码（订阅/回放失败）。
 *
 * 与运行失败码分开放置：它们不会被落库到 task.lastError，也不应被
 * runErrorMessage 当作运行失败码映射，但同样遵循 T6 的
 * `{ message: <中文展示文案>, error: <机器码> }` 约定。
 */
export const RELAY_ERROR_MESSAGES = {
  event_bus_unavailable: '事件订阅失败，请重试',
  steps_unavailable: '历史步骤读取失败，请重试',
} as const;

export type RelayErrorCode = keyof typeof RELAY_ERROR_MESSAGES;

export function errorPayload(code: RunErrorCode): { message: string; error: RunErrorCode } {
  return { message: RUN_ERROR_MESSAGES[code], error: code };
}

export function relayErrorPayload(code: RelayErrorCode): {
  message: string;
  error: RelayErrorCode;
} {
  return { message: RELAY_ERROR_MESSAGES[code], error: code };
}

/**
 * 把落库的 task.lastError 还原成浏览器可读的 error 负载。
 *
 * lastError 可能存的是机器码（如 worker_lost）也可能为空：已知码映射为对应中文，
 * 未知码/null 一律收敛为 run_failed 的通用文案，绝不让英文机器码漏到用户界面。
 * 原始字符串只保留在 DB/管理端，诊断信息请走日志。
 */
export function runErrorMessage(lastError: string | null): {
  message: string;
  error: RunErrorCode;
} {
  const known =
    lastError !== null && Object.prototype.hasOwnProperty.call(RUN_ERROR_MESSAGES, lastError);
  return errorPayload(known ? (lastError as RunErrorCode) : 'run_failed');
}
