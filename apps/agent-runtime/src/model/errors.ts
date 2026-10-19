/** 模型 HTTP 错误：携带状态码，供路由网关判断是否可 fallback。 */
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly model: string,
  ) {
    super(`model_http_${status}`);
    this.name = 'ModelHttpError';
  }
}
