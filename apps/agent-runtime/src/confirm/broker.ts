export type ConfirmReason = 'user_denied' | 'confirm_timeout';

export interface ConfirmDecisionResult {
  approved: boolean;
  reason?: ConfirmReason;
}

/**
 * 确认闸门：`confirm` 级工具在执行前挂起，等用户决策或超时。
 * 单实例内存态（与 v1 无状态单实例现状匹配）；跨重启恢复是 M5 队列化的活。
 */
export interface ConfirmGate {
  /** 挂起等待决策；超时按 approved=false + reason=confirm_timeout 兑现。同一 runId 至多一个挂起。 */
  request(runId: string, confirmId: string, timeoutMs: number): Promise<ConfirmDecisionResult>;
  /** 兑现挂起闸门；confirmId 不匹配或不存在返回 false（幂等，不抛错）。 */
  resolve(runId: string, confirmId: string, approved: boolean): boolean;
  /** 连接断开兜底：按拒绝兑现并清理。 */
  cancel(runId: string): void;
}

interface Pending {
  confirmId: string;
  settle: (r: ConfirmDecisionResult) => void;
  timer: NodeJS.Timeout;
}

export class ConfirmBroker implements ConfirmGate {
  private readonly pending = new Map<string, Pending>();

  request(runId: string, confirmId: string, timeoutMs: number): Promise<ConfirmDecisionResult> {
    return new Promise((resolveResult) => {
      if (this.pending.has(runId)) {
        // 工具调用串行，理论不会并发；防御性拒绝新请求，避免状态错乱。
        resolveResult({ approved: false });
        return;
      }
      const timer = setTimeout(() => {
        const p = this.pending.get(runId);
        if (!p) return;
        this.pending.delete(runId);
        p.settle({ approved: false, reason: 'confirm_timeout' });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(runId, { confirmId, settle: resolveResult, timer });
    });
  }

  resolve(runId: string, confirmId: string, approved: boolean): boolean {
    const p = this.pending.get(runId);
    if (!p || p.confirmId !== confirmId) return false;
    this.pending.delete(runId);
    clearTimeout(p.timer);
    p.settle(approved ? { approved: true } : { approved: false, reason: 'user_denied' });
    return true;
  }

  cancel(runId: string): void {
    const p = this.pending.get(runId);
    if (!p) return;
    this.pending.delete(runId);
    clearTimeout(p.timer);
    p.settle({ approved: false, reason: 'user_denied' });
  }
}
