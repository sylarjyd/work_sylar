import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** 读密钥并校验；缺或非 32 字节 hex 即抛错（fail-fast）。 */
function key(envName: string): Buffer {
  const hex = process.env[envName];
  if (!hex) throw new Error(`${envName} 未设置`);
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error(`${envName} 必须是 32 字节 hex`);
  return buf;
}

/** 启动期自检：缺/非法密钥直接崩，避免运行到首次读写密文才暴露。 */
export function assertSecretKey(envName: string): void {
  key(envName);
}

/** 加密为 base64(IV ‖ authTag ‖ ciphertext)；不同环境变量可使用不同密钥。 */
export function encryptSecret(plain: string, envName: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(envName), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** 解密 base64(IV ‖ authTag ‖ ciphertext)；篡改/换密钥时抛错。 */
export function decryptSecret(blob: string, envName: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(envName), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
