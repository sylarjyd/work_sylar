import { describe, expect, it } from 'vitest';
import {
  assertProviderBaseUrl,
  isStoredProviderUrlAllowed,
  validateProviderBaseUrl,
} from './provider-url';

const publicResolver = async () => ['93.184.216.34'];

describe('validateProviderBaseUrl', () => {
  it('接受公网 http(s) 地址并去掉尾部斜杠', async () => {
    await expect(
      validateProviderBaseUrl('https://api.deepseek.com/v1/', {
        env: {},
        resolveHosts: publicResolver,
      }),
    ).resolves.toBe('https://api.deepseek.com/v1');
  });

  it('拒绝非 http(s)、带账号密码与非法地址', async () => {
    for (const raw of ['ftp://example.com/v1', 'https://u:p@example.com/v1', 'not a url', '']) {
      await expect(
        validateProviderBaseUrl(raw, { env: {}, resolveHosts: publicResolver }),
      ).rejects.toMatchObject({ message: 'invalid_base_url' });
    }
  });

  it('默认拒绝回环、RFC1918、CGNAT 与 IPv6 本地地址', async () => {
    for (const raw of [
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
      'http://10.0.0.1/v1',
      'http://172.16.3.4/v1',
      'http://192.168.1.2/v1',
      'http://100.64.0.1/v1',
      'http://[fc00::1]/v1',
      'http://[::ffff:127.0.0.1]/v1',
      'http://localhost:11434/v1',
    ]) {
      await expect(
        validateProviderBaseUrl(raw, { env: {}, resolveHosts: publicResolver }),
      ).rejects.toMatchObject({ message: 'provider_url_blocked' });
    }
  });

  it('域名解析到内网地址时拒绝', async () => {
    await expect(
      validateProviderBaseUrl('https://models.example.com/v1', {
        env: {},
        resolveHosts: async () => ['93.184.216.34', '192.168.0.9'],
      }),
    ).rejects.toMatchObject({ message: 'provider_url_blocked' });
  });

  it('开启 MODEL_ALLOW_PRIVATE_BASE_URL 后放行内网与回环', async () => {
    const env = { MODEL_ALLOW_PRIVATE_BASE_URL: '1' };
    for (const raw of ['http://127.0.0.1:11434/v1', 'http://10.0.0.1/v1', 'http://[::1]:8080/v1']) {
      await expect(
        validateProviderBaseUrl(raw, { env, resolveHosts: publicResolver }),
      ).resolves.toBe(raw.replace(/\/+$/, ''));
    }
  });

  it('云元数据与链路本地地址始终拒绝', async () => {
    for (const raw of [
      'http://169.254.169.254/latest',
      'http://100.100.100.200/latest',
      'http://[fe80::1]/v1',
      'http://0.0.0.0/v1',
    ]) {
      await expect(
        validateProviderBaseUrl(raw, {
          env: { MODEL_ALLOW_PRIVATE_BASE_URL: '1' },
          resolveHosts: publicResolver,
        }),
      ).rejects.toMatchObject({ message: 'provider_url_blocked' });
    }
    await expect(
      validateProviderBaseUrl('http://metadata.google.internal/computeMetadata/v1', {
        env: { MODEL_ALLOW_PRIVATE_BASE_URL: '1' },
        resolveHosts: publicResolver,
      }),
    ).rejects.toMatchObject({ message: 'provider_url_blocked' });
  });

  it('DNS 解析失败不拦截（请求本身也无法到达内网）', async () => {
    await expect(
      validateProviderBaseUrl('https://offline.example/v1', {
        env: {},
        resolveHosts: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).resolves.toBe('https://offline.example/v1');
  });
});

describe('assertProviderBaseUrl / isStoredProviderUrlAllowed', () => {
  it('同步校验字面量地址，不做 DNS', () => {
    expect(assertProviderBaseUrl('https://api.deepseek.com/v1/', {})).toBe(
      'https://api.deepseek.com/v1',
    );
    expect(isStoredProviderUrlAllowed('http://127.0.0.1:9/v1', {})).toBe(false);
    expect(isStoredProviderUrlAllowed('http://169.254.169.254/latest', { MODEL_ALLOW_PRIVATE_BASE_URL: '1' })).toBe(false);
    expect(isStoredProviderUrlAllowed('http://127.0.0.1:9/v1', { MODEL_ALLOW_PRIVATE_BASE_URL: '1' })).toBe(true);
    expect(isStoredProviderUrlAllowed('https://models.internal.example/v1', {})).toBe(true);
  });
});
