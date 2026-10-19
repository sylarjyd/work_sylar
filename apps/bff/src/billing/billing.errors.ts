/** 可用积分不足（映射 402）。 */
export class InsufficientCreditsError extends Error {
  constructor() {
    super('insufficient_credits');
    this.name = 'InsufficientCreditsError';
  }
}

/** 套餐过期（映射 402）。 */
export class PlanExpiredError extends Error {
  constructor() {
    super('plan_expired');
    this.name = 'PlanExpiredError';
  }
}

/** 运行频率超限（映射 429）。 */
export class RateLimitedError extends Error {
  constructor(readonly retryAfter: number) {
    super('rate_limited');
    this.name = 'RateLimitedError';
  }
}
