import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, assertConnectorKey } from './crypto';

const KEY = 'a'.repeat(64); // 32 字节 hex

beforeEach(() => {
  process.env.CONNECTOR_ENC_KEY = KEY;
});

describe('connector crypto', () => {
  it('加解密往返', () => {
    const plain = JSON.stringify({ API_KEY: 'sk-1', TOKEN: '中文✓' });
    const blob = encrypt(plain);
    expect(blob).not.toContain('sk-1');
    expect(decrypt(blob)).toBe(plain);
  });

  it('同一明文两次加密产生不同密文（随机 IV）', () => {
    expect(encrypt('x')).not.toBe(encrypt('x'));
  });

  it('密文被篡改时解密抛错', () => {
    const blob = encrypt('secret');
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });

  it('换密钥后解不开（认证失败）', () => {
    const blob = encrypt('secret');
    process.env.CONNECTOR_ENC_KEY = 'b'.repeat(64);
    expect(() => decrypt(blob)).toThrow();
  });

  it('assertConnectorKey 缺密钥或长度错时抛错', () => {
    delete process.env.CONNECTOR_ENC_KEY;
    expect(() => assertConnectorKey()).toThrow('CONNECTOR_ENC_KEY 未设置');
    process.env.CONNECTOR_ENC_KEY = 'abcd';
    expect(() => assertConnectorKey()).toThrow('CONNECTOR_ENC_KEY 必须是 32 字节 hex');
  });
});
