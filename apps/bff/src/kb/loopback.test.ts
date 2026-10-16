import { describe, it, expect } from 'vitest';
import { isLoopback } from './loopback';

describe('isLoopback', () => {
  it('识别 IPv4 / IPv6 / IPv4-mapped 回环地址', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.5.5.5')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('公网/局域网地址与空值判为非回环', () => {
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('192.168.1.2')).toBe(false);
    expect(isLoopback('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopback('::2')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
  });
});
