import { beforeEach, describe, expect, it } from 'vitest';
import { assertSecretKey, decryptSecret, encryptSecret } from './secret-box';

const KEY = 'a'.repeat(64); // 32 字节 hex

beforeEach(() => {
  process.env.TEST_ENC_KEY = KEY;
});

describe('secret-box', () => {
  it('加解密往返且密文不含明文', () => {
    const plain = JSON.stringify({ apiKey: 'sk-1', note: '中文✓' });
    const blob = encryptSecret(plain, 'TEST_ENC_KEY');
    expect(blob).not.toContain('sk-1');
    expect(decryptSecret(blob, 'TEST_ENC_KEY')).toBe(plain);
  });

  it('同一明文两次加密产生不同密文（随机 IV）', () => {
    expect(encryptSecret('x', 'TEST_ENC_KEY')).not.toBe(encryptSecret('x', 'TEST_ENC_KEY'));
  });

  it('密文被篡改时解密抛错', () => {
    const blob = encryptSecret('secret', 'TEST_ENC_KEY');
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptSecret(raw.toString('base64'), 'TEST_ENC_KEY')).toThrow();
  });

  it('换密钥后解不开（认证失败）', () => {
    const blob = encryptSecret('secret', 'TEST_ENC_KEY');
    process.env.TEST_ENC_KEY = 'b'.repeat(64);
    expect(() => decryptSecret(blob, 'TEST_ENC_KEY')).toThrow();
  });

  it('assertSecretKey 缺密钥或长度错时抛带环境变量名的错误', () => {
    delete process.env.TEST_ENC_KEY;
    expect(() => assertSecretKey('TEST_ENC_KEY')).toThrow('TEST_ENC_KEY 未设置');
    process.env.TEST_ENC_KEY = 'abcd';
    expect(() => assertSecretKey('TEST_ENC_KEY')).toThrow('TEST_ENC_KEY 必须是 32 字节 hex');
  });
});
