import { describe, it, expect } from 'vitest';
import { errorText } from './errors';

describe('errorText', () => {
  it('网络异常转成友好文案', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('网络请求失败，请确认服务已启动后重试');
  });

  it('按状态码映射常见业务错误', () => {
    expect(errorText(new Error('connectors_failed_403'))).toBe('没有权限执行该操作');
    expect(errorText(new Error('kb_upload_failed_413'))).toBe('文件过大，请压缩后重试');
    expect(errorText(new Error('stream_failed_500: boom'))).toBe('服务暂时不可用，请稍后重试');
  });

  it('无法识别的错误保留原文', () => {
    expect(errorText(new Error('something_odd'))).toBe('something_odd');
  });
});
