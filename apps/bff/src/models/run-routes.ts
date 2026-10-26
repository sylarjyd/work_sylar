import type { RunModelRoute } from '@ai-office/shared';
import { decryptSecret, encryptSecret } from '../secrets/secret-box';
import { MODEL_ENC_KEY } from './model.constants';

/** 快照落库前加密厂商密钥：Task.input 会被备份与运维查询读到，不能留明文。 */
export function sealRoutes(routes: RunModelRoute[]): RunModelRoute[] {
  return routes.map((r) => ({ ...r, apiKey: encryptSecret(r.apiKey, MODEL_ENC_KEY) }));
}

/** 执行器下发 runtime 前解密；与 sealRoutes 必须成对使用。 */
export function unsealRoutes(routes: RunModelRoute[]): RunModelRoute[] {
  return routes.map((r) => ({ ...r, apiKey: decryptSecret(r.apiKey, MODEL_ENC_KEY) }));
}
