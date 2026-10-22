import { HttpException } from '@nestjs/common';

/** 套餐过期/未激活：客户端当前没有可用模型。 */
export class ModelPlanExpiredError extends HttpException {
  constructor() {
    super('plan_expired', 402);
  }
}

/** 当前套餐与全局启用模型的交集为空。 */
export class NoModelsAvailableError extends HttpException {
  constructor() {
    super('no_models_available', 400);
  }
}

/** 会话选定的模型已被停用/移出套餐。 */
export class ModelUnavailableError extends HttpException {
  constructor() {
    super('model_unavailable', 409);
  }
}

/** 选中模型的厂商密钥无法解密，无法发起本次运行。 */
export class ModelProviderUnavailableError extends HttpException {
  constructor() {
    super('model_provider_unavailable', 503);
  }
}
