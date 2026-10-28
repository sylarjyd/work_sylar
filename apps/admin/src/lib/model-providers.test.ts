import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, presetByKey, presetKeyOfBaseUrl } from './model-providers';

describe('厂商预设', () => {
  it('每个预设都有名称与 https/http 的 Base URL，且 key 唯一', () => {
    const keys = new Set<string>();
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.baseUrl).not.toMatch(/\/$/);
      keys.add(preset.key);
    }
    expect(keys.size).toBe(PROVIDER_PRESETS.length);
  });

  it('按 key 取预设，按地址反查 key（忽略末尾斜杠）', () => {
    expect(presetByKey('deepseek')?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(presetByKey('missing')).toBeUndefined();
    expect(presetKeyOfBaseUrl('https://api.deepseek.com/v1/')).toBe('deepseek');
    expect(presetKeyOfBaseUrl('https://custom.example.com/v1')).toBeUndefined();
  });
});
