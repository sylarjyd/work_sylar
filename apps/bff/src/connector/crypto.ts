import { assertSecretKey, decryptSecret, encryptSecret } from '../secrets/secret-box';

const ENV_NAME = 'CONNECTOR_ENC_KEY';

/** 启动期自检：缺/非法密钥直接崩，避免运行到首次写连接器才暴露。 */
export function assertConnectorKey(): void {
  assertSecretKey(ENV_NAME);
}

/** 加密为 base64(IV ‖ authTag ‖ ciphertext)。 */
export function encrypt(plain: string): string {
  return encryptSecret(plain, ENV_NAME);
}

/** 解密 base64(IV ‖ authTag ‖ ciphertext)；篡改/换密钥时抛错。 */
export function decrypt(blob: string): string {
  return decryptSecret(blob, ENV_NAME);
}
